# `@wrap-esm-lambda/core`

Shared core of the hybrid instrumentation setup: one declarative config
(`defineConfig` / `definePatches`), one matcher (`matchEntries`), and one
apply step (`applyMatched`) built on a pluggable transform engine — the
native `wrap-esm-lambda` oxc addon by default, or the pure-JS
[`@wrap-esm-lambda/engine-acorn`](../engine-acorn) (see
[Choosing the engine](#choosing-the-engine)).

Both shells consume this package, so the instrumented output is byte-identical
whichever mode produced it:

- [`@wrap-esm-lambda/hooks`](../hooks) — runtime, via `module.registerHooks`
- [`@wrap-esm-lambda/unplugin`](../unplugin) — build time, via a bundler plugin

`applyMatched` also appends a sentinel comment and skips sources that already
carry it, so enabling both modes at once never double-wraps.

The source layout mirrors the pipeline a patch travels — every symbol is
re-exported from [`src/index.mjs`](src/index.mjs):

| module                                 | responsibility                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`src/config.mjs`](src/config.mjs)     | the entry shapes users write (`defineConfig` / `definePatches`, typedefs)                 |
| [`src/match.mjs`](src/match.mjs)       | which entries apply to which module: package identity, semver range, files, builtin split |
| [`src/format.mjs`](src/format.mjs)     | the CJS-or-ESM decision, reproducing Node's own format rules                              |
| [`src/engine.mjs`](src/engine.mjs)     | the transform engine binding: native oxc addon (default) or the pure-JS acorn engine      |
| [`src/apply.mjs`](src/apply.mjs)       | entries -> instrumented source via the selected engine, plus the double-wrap sentinel     |
| [`src/registry.mjs`](src/registry.mjs) | the runtime patch-function registry contract shared with the Rust emission                |
| [`src/stars.mjs`](src/stars.mjs)       | the `export * from` graph walk resolving star-forwarded names at transform time           |
| [`src/range.mjs`](src/range.mjs)       | the semver-range matcher (replaces the `semver` package for cold start; loud on typos)    |

## Choosing the engine

Every transform call goes through [`src/engine.mjs`](src/engine.mjs), which
binds once, at load time, to one of two implementations of the same surface:

- `oxc` (default) — the native `wrap-esm-lambda` addon: oxc parse/codegen in
  Rust, module sources crossing napi zero-copy as UTF-8 buffers;
- `acorn` — [`@wrap-esm-lambda/engine-acorn`](../engine-acorn): acorn +
  magic-string, pure JS, no native binary anywhere.

```sh
WRAP_ESM_LAMBDA_ENGINE=acorn node --import @wrap-esm-lambda/hooks/register app.mjs
```

The choice is process-wide by design (both shells instrument every matched
module with it), and an unknown name fails loudly at startup. The engines
emit byte-identical snippets, share error messages, and pass the identical
test suite; the trade-off is performance — the parse-dominated tap runs ~6x
faster through oxc — versus running with no native dependency at all. Numbers
in [docs/benchmarks.md](../../docs/benchmarks.md#js-only-vs-js--rust-the-two-engines).

## Patch author contract

A patch entry hands your function the matched module's exports. This is the
contract your code runs under — the deliberate parts and the current
prototype gaps, marked as such.

### The call

- Your patch is a plain **named export** (`patch.name`) of the module at
  `patch.from`.
- It is called **synchronously, exactly once per patched file, at the end of
  that file's evaluation** — after the module's definitions exist, before any
  importer runs.
- Everything it does must be synchronous: the return value is ignored, so an
  async patch would apply only after importers already hold references.
- It runs once _per file instance_: two copies or versions of a package in
  the dependency graph each get patched, each with their own class objects —
  that is correct, not double-patching.
- If it throws, the patched module's load fails, in both modes.

### What it receives

Not the module namespace — an accessor object containing **only** the
requested `bindings`:

- `bindings.X` reads the current live value. Mutating the object
  (`X.prototype.send = ...`) is the bread-and-butter path and works
  everywhere.
- `bindings.X = wrapped` **rebinds**: in ESM it reassigns the module-local
  binding (live bindings propagate to every importer), in CJS it writes
  `module.exports.X`.
- Every statically-visible ESM export shape is rebindable. Shapes that are
  not naturally rebindable make the tap **restructure the module** (an AST
  rewrite through oxc codegen, with a source map) instead of refusing:
  - `export const X = ...` — the declaration is demoted to `let` so the
    binding accepts assignment. (Consequence: the whole declaration loses
    const-ness, including co-declared names; the module itself never
    reassigns what it declared `const`, so this is unobservable in practice.)
  - Destructuring exports — `export const { a, b: c } = ...`, array
    patterns, defaults and rest elements: every name the pattern binds is
    tappable, with the same const demotion. This also covers a top-level
    `const` pattern re-exported through an `export { ... }` list.
  - `export default` — a named default function/class is tapped through its
    local binding (`bindings.default`); an anonymous one is named into a
    local and re-exported as `default`.
  - `export { a as b } from "m"` (re-exports, including
    `export { default as X }`), `export * as ns from "m"` (namespace
    re-exports) and list exports of import-backed locals (named, default or
    namespace imports) — split into an import plus a rebindable `let`
    snapshot. **Snapshot caveat**: after the split, `b` no longer tracks
    later live-binding updates of `a` in `m`; for the overwhelmingly common
    class/function exports this is indistinguishable, but if the source
    module reassigns its export after evaluation, importers of the patched
    module keep the snapshot (until the patch itself rebinds).
  - Bare `export * from "m"` — the forwarded names are not visible in the
    module's own source, but they are knowable at transform time: the
    transform walks the star sources (reading and parsing each file,
    recursively — the same resolution Node's linker performs) to find which
    one provides the requested name, then appends a shadow export
    redirecting it through a rebindable local. An explicit named export
    shadows `export *` for the same name, so the star statement itself is
    untouched and the whole fix is append-only. Loud limits: a star with a
    **bare specifier** (`export * from "pkg"`) is not walked (the transform
    owns no module resolution — the error names the unresolved sources), a
    name provided by **two** star sources is refused as ambiguous (importers
    cannot link it either), and a star pointing at a **CJS** file has no
    statically knowable names.
- CJS getter-only exports (esbuild-bundled packages) make rebind assignment
  throw in strict-mode modules but **silently no-op in sloppy-mode ones** —
  the tap's CJS setter verifies the write took and throws if not; prototype
  mutation is the reliable operation on bundled CJS.
- Validation: a requested export that does not exist is a **hard error at
  transform time for ESM** (the version-drift alarm). CJS cannot be validated
  statically — a missing name arrives as `undefined`.

### Reach limits (by design)

The tap reaches what `Module._load` monkey-patching ever could:

- Only exports listed in `bindings` — no non-exported internals, no
  call-site interiors.
- Nothing that already happened _during_ the module's own top-level
  evaluation can be intercepted, and code that captured a direct method
  reference before the tap ran keeps the unpatched one.
- Re-export barrels are tappable (see the snapshot caveat above), but
  targeting the defining file remains the recommended config (see the AWS
  config, which taps `smithy-client/client.js` rather than the barrel
  `index.js`): no restructuring, no snapshot semantics, and the patch lands
  no matter which path imports the class.

### Delivery-mode asymmetry

The patch **module** is loaded differently per mode, which imposes the
subtlest constraints:

- Runtime: imported once by the register entry _before_ hooks install — its
  own imports are not instrumented (no patching-the-patcher). TypeScript
  patch files ride on Node's type stripping (Node >= 22.18, file outside
  `node_modules`).
- Build: imported _by the patched module_ and bundled into the artifact.
- Therefore keep the patch module **free of top-level side effects**: they
  would run at preload time in one mode and at patched-module-eval time in
  the other, quietly breaking the identical-behavior guarantee. Pure exported
  functions only.
- `patch.from` should be an **absolute path** (compute it via
  `import.meta.url`, as the test configs do). A relative specifier resolves
  against the _patched module_ in build mode; a bare package specifier
  currently resolves from the hooks package at preload, which is fragile
  under pnpm's strict layout.

### Dependencies

A patch module may carry a full dependency graph of its own — this is tested,
not assumed (`__test__/patch.spec.ts`, the `patch dependencies` pair):

- **Relative imports** (including TypeScript files, stripped by Node) and
  **bare npm specifiers** both work, resolving from the patch file's own
  location. Runtime mode loads the graph once at preload; build mode lets the
  bundler pull it into the artifact. Same output either way.
- **One hard rule: never import the instrumented package's graph at the patch
  module's top level.** This is the one dependency shape where the two modes
  _disagree_, pinned by the `DOCUMENTED FOOTGUN` test:
  - Runtime: preloading the patch pulls the target into the module cache
    _before_ hooks install, so the app receives the cached, unpatched module —
    the patch **silently does nothing**.
  - Build: the bundler resolves the cycle through hoisted imports and the
    patch **works** — so the bug only surfaces in whichever mode you test
    second.
- Escape hatches when the patch genuinely needs the target's API (an
  `instanceof` check, a middleware class): load it lazily _inside_ the patch
  function body (`createRequire(import.meta.url)` or a dynamic `import()` of
  something outside the instrumented files), or avoid the import entirely by
  duck-typing (`command.constructor.name`) — the bindings object already hands
  you the live classes.

### Failure modes

- Runtime: the emitted tap is guarded — if the registry entry is missing
  (transformed output evaluated without the register entry), it is a silent
  no-op rather than a crash.
- Build: a missing or broken `patch.from` fails loudly at bundle time.
- The register entry throws at startup if `patch.name` is not exported by
  `patch.from`.
