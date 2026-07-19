# `@wrap-esm-lambda/core`

Shared core of the hybrid instrumentation setup: one declarative config
(`defineConfig` / `definePatches`), one matcher (`matchEntries`), and one
apply step (`applyMatched`) built on the native `wrap-esm-lambda` oxc addon.

Both shells consume this package, so the instrumented output is byte-identical
whichever mode produced it:

- [`@wrap-esm-lambda/hooks`](../hooks) — runtime, via `module.registerHooks`
- [`@wrap-esm-lambda/unplugin`](../unplugin) — build time, via a bundler plugin

`applyMatched` also appends a sentinel comment and skips sources that already
carry it, so enabling both modes at once never double-wraps.

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
- Rebinding edges:
  - ESM `export const` gets no setter — assignment throws loudly; mutate the
    object instead.
  - `export { a as b }` list exports always get a setter; if the local is a
    `const`, assigning throws at runtime.
  - CJS getter-only exports (esbuild-bundled packages) make rebind assignment
    throw in strict-mode modules but **silently no-op in sloppy-mode ones** —
    prototype mutation is the reliable operation on bundled CJS.
- Validation: a requested export that does not exist is a **hard error at
  transform time for ESM** (the version-drift alarm). CJS cannot be validated
  statically — a missing name arrives as `undefined`.

### Reach limits (by design)

The tap reaches exactly what `Module._load` monkey-patching ever could:

- Only exports listed in `bindings` — no non-exported internals.
- No re-exports: `export ... from` has no local binding; the transform
  refuses loudly. Target the defining file instead (see the AWS config,
  which taps `smithy-client/client.js` rather than the barrel `index.js`).
- Nothing that already happened _during_ the module's own top-level
  evaluation can be intercepted, and code that captured a direct method
  reference before the tap ran keeps the unpatched one.
- `export default` is currently unsupported (prototype gap, not principle).

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

### Failure modes

- Runtime: the emitted tap is guarded — if the registry entry is missing
  (transformed output evaluated without the register entry), it is a silent
  no-op rather than a crash.
- Build: a missing or broken `patch.from` fails loudly at bundle time.
- The register entry throws at startup if `patch.name` is not exported by
  `patch.from`.
