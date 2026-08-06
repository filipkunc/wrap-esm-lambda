# How the exports tap works

The transform behind both delivery modes: what gets appended to a matched
module, when the source is rewritten, and why the mechanism reaches targets
the classic alternatives cannot. (For the user-facing rules a patch function
runs under, see the
[patch author contract](../packages/core/README.md#patch-author-contract).)

## The tiered transform

The matched module is parsed once (full AST — [oxc](https://oxc.rs/) in the
native engine, acorn in the pure-JS one) and every requested binding is
validated against its statically visible exports — a missing export is a hard
error, the version-drift alarm. Then the tap is **tiered**:

- **Fast path** — when every requested binding is already a reassignable
  local (function/class/`let`/`var` declarations, list exports of mutable
  locals: the common case for classes like smithy's `Client`), the tap only
  **appends** a snippet calling your patch function with get/set accessors
  over the live bindings. The source is untouched, existing source maps stay
  valid, and on the runtime path the bytes never leave UTF-8.
- **Rewrite path** — shapes that cannot be rebound as written are
  **restructured** through one AST rewrite (with a source map):
  `export const` is demoted to `let` (destructuring patterns included), an
  anonymous `export default` is named into a local, and re-exports —
  `export { a as b } from`, `export * as ns from`, import-backed list
  exports — are split into an import plus a rebindable local. Even a bare
  `export * from` resolves: the transform walks the star sources' files to
  find the provider — following bare specifiers (`export * from "pkg"`)
  through full import-style package resolution
  ([oxc_resolver](https://docs.rs/oxc_resolver) natively, its JS twin in the
  acorn engine) — then appends a shadow export (explicit exports shadow
  `export *`, so this one is append-only). Only modules that need a
  rewrite pay for one; what stays loud: ambiguous star names, stars into
  CJS, stars into packages that are not installed. _How_ the rewrite edits
  the source is the one place the engines diverge, and comments forced the
  choice: bundlers hang real semantics on them (`/* @__PURE__ */`
  tree-shake annotations, webpack magic comments, `/*!` legal comments),
  and while oxc codegen preserves them as a feature, a JS printer in the
  [astring](https://github.com/davidbonnet/astring) lineage cannot
  reasonably reprint them. So the native engine regenerates the whole
  program through oxc codegen, while the acorn engine makes surgical
  [magic-string](https://github.com/rich-harris/magic-string) edits —
  preservation is structural (unedited bytes cannot change), untouched
  lines keep their exact source text, and the emitted map stays sparse.
  Same output contract either way, down to byte-identical snippets.

Either way the patch call runs at the end of the module's own evaluation:
after its definitions exist, before any importer sees them.

## Binding semantics

- `bindings.X` reads the live value; mutating it
  (`X.prototype.send = ...`) works everywhere.
- `bindings.X = wrapped` **rebinds** the export — an ESM live binding
  reassignment or a `module.exports.X` write. The reserved
  `'module.exports'` binding rebinds a CJS module whose export _is_ the API
  (fastify's factory); `'default'` taps a default export.
- ESM and CJS get mode-specific snippets; the CJS-or-ESM decision reproduces
  Node's own format rules at runtime (extension, then nearest package.json
  `"type"`), and falls back to the same **syntax detection** bundlers
  themselves use at build time, where no format hint exists — so a pure-CJS
  express, the AWS SDK's `"type"`-less ESM `dist-es`, and the two trees of a
  dual package like hono each land on their real tap in both shells.
- The CJS tap rides an **evaluation wrap**, not a bare append: the module
  body becomes an arrow IIFE, `;(() => { <body> })(); <tap>`, because the
  CJS wrapper is a function — a module that exits through a top-level
  `return` (bundlers wrap CJS in a function too) would silently skip
  anything merely appended. The arrow is the load-bearing choice: a
  `try/finally` would put sloppy-mode `function` declarations in a block,
  where bundlers' Annex B lowering renames them (esbuild turned
  graceful-fs's `patch` into `patch2` — an observable `Function.name`
  change the corpus caught), while a function body adds no block and
  inherits the wrapper's `this` and `arguments` untouched. Directives
  become the arrow body's own prologue, so strict mode survives without
  hoisting; the prefix adds no newline, so every line keeps its number and
  an upstream source map stays line-accurate — and for the module the
  no-newline trick cannot save, a minified single-line bundle whose whole
  body is the insertion line, the apply step returns a corrected copy of
  the module's own map (first mapped segment of that line shifted by the
  prefix width; VLQ columns are deltas, so the line reflows), which the
  runtime hook inlines after the code (the last `sourceMappingURL` comment
  wins) and the build shell hands to the bundler; cjs-module-lexer still sees
  the `exports` writes, so named ESM imports keep resolving; and a body
  that **throws** never reaches the tap after the call — matching the ESM
  tap, which never runs on a failed evaluation.
- Patch delivery differs per mode: at build time a static import of your
  patch module is appended and bundled (a `require()` call when the patched
  module is CJS — appended `import` syntax would flip its format under the
  bundler's own detection); at runtime the register entry preloads patch
  functions into a global registry the tap reads (a hook-overridden CJS
  source cannot serve an injected `require`).

Full rules — call timing, rebinding edges, dependency dos and don'ts, failure
modes — live in the
[patch author contract](../packages/core/README.md#patch-author-contract),
each backed by a test.

## Why not `Module._load` / a loader proxy?

Three mechanism classes exist for reaching a module's exports, and each has a
blind spot ([full comparison](comparisons.md), with tests over identical
targets):

- **`Module._load` patching** (require-in-the-middle lineage) never sees
  `import` of a builtin, historically lost `import`-ed CJS whenever Node's
  loader shifted ([the breakage trail](history.md)), and has no
  build-time story.
- **Loader proxies** ([import-in-the-middle](https://github.com/nodejs/import-in-the-middle))
  never see a pure `require()` chain — the path the real AWS SDK takes under
  plain `node`.
- **Body-rewriting transforms** ([orchestrion-js](https://github.com/nodejs/orchestrion-js))
  can reach non-exported internals, but user code only _observes_ events —
  and the transform costs ~100x more per module.

The exports tap patches both module systems from one declarative entry, works
at build time too, and never touches `Module._load` — the
[interplay matrix](../hooks/interplay-matrix) shows it behaving identically on
every Node 22/24/26 rung, including the minors where sync hooks and
`Module._load` miscomposed.

For observe-only needs on core modules, Node's own
[`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
tracing channels are the sanctioned alternative — the eager patch is for when
you need to wrap or rebind.

## History: the transform this replaced

The dedicated Lambda-handler transform this repo started with is gone —
everything runs on the generic tap, and the handler shape rides its rewrite
path. Stack traces survive: the rewrite emits a source map, chained all the
way back to an original `.ts` when an upstream map exists — composed in Rust
without leaving the addon ([source-maps.md](source-maps.md)). The research
that got here — the wrap re-implemented with [Babel](https://babeljs.io/),
[Acorn](https://github.com/acornjs/acorn), [swc.rs](https://swc.rs/) and
loader hooks of every flavor — lives in [history.md](history.md) and the
[presentations](../Presentation.md); today's benchmark compares the tap
against [orchestrion-js](https://github.com/nodejs/orchestrion-js) and
[import-in-the-middle](https://github.com/nodejs/import-in-the-middle) on a
real AWS SDK module ([benchmarks.md](benchmarks.md)).
