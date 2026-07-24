# `@wrap-esm-lambda/engine-acorn`

The pure-JavaScript transform engine: the same API surface as the native
`wrap-esm-lambda` oxc addon (the contract lives in the root
[`index.d.ts`](../../index.d.ts)), implemented on
[acorn](https://github.com/acornjs/acorn) (parse),
[magic-string](https://github.com/rich-harris/magic-string) (edit + source
map) and [`@jridgewell/remapping`](https://github.com/jridgewell/sourcemaps)
(map chaining — the maintained home of `@ampproject/remapping`). No native
code anywhere in the graph.

Core binds to one engine per process via `WRAP_ESM_LAMBDA_ENGINE`
(see [`packages/core/src/engine.mjs`](../core/src/engine.mjs)):

```sh
WRAP_ESM_LAMBDA_ENGINE=acorn \
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs \
node --import @wrap-esm-lambda/hooks/register app.mjs
```

Both shells (runtime hook and bundler plugin) work unchanged on either
engine; the whole test suite runs against both in CI.

## Why it exists

- **A JS-only deployment story.** The native addon needs a prebuilt binary
  per platform (or a wasm fallback); this engine runs wherever Node runs.
- **An honest JS-vs-Rust benchmark.** Same contract, same emitted snippets,
  same tests — the perf gap between the engines is exactly the parse/rewrite
  implementation, nothing else. Numbers and analysis in
  [docs/benchmarks.md](../../docs/benchmarks.md#js-only-vs-js--rust-the-two-engines):
  the short version is ~6x slower on the parse-dominated tap (~86 µs vs
  ~14 µs on the real `@smithy/core` client file), _faster_ on the parse-free
  CJS snippet (no napi boundary to cross), and ~14 ms more runtime-hook
  cold start.

## The contract it upholds

[`__test__/engine-parity.spec.ts`](../../__test__/engine-parity.spec.ts)
pins, against the native engine:

- **byte-identical snippets** for every tap emission (registry and import
  delivery, CJS accessors with verified setters, star-resolution stubs) —
  both engines feed the same runtime registry contract;
- **byte-identical rewrite output** on conventionally formatted sources for
  every rewrite shape (const demotion, anonymous default naming, re-export
  and namespace splits, import-backed list exports);
- **identical error messages** for missing exports — core's star-graph
  retry ([`stars.mjs`](../core/src/stars.mjs)) matches on that text;
- **identical `esmModuleExports` surfaces** — the star walk behaves the same
  on either engine.

## How the rewrite differs (by design)

The native engine regenerates the whole module through oxc codegen. This
engine edits the source in place — demote one `const` keyword, replace one
export statement, append the redirects — so untouched lines keep their
exact bytes and the emitted source map is sparse. Maps still chain through
an upstream (e.g. tsc) map, via `remapping` instead of `oxc_sourcemap`.

The module layout mirrors the native side ([`src/transform.rs`](../../src/transform.rs)):

| module                                           | responsibility                                             |
| ------------------------------------------------ | ---------------------------------------------------------- |
| [`src/exports-index.mjs`](src/exports-index.mjs) | one-pass export surface index (`build_export_index` twin)  |
| [`src/snippets.mjs`](src/snippets.mjs)           | emitted-text builders, byte-identical to the Rust emission |
| [`src/tap.mjs`](src/tap.mjs)                     | the exports tap: fast path + magic-string rewrites         |
| [`src/wrap.mjs`](src/wrap.mjs)                   | the original handler-wrap transform                        |
| [`src/sourcemaps.mjs`](src/sourcemaps.mjs)       | map chaining (`remapping`) and data-URL inlining           |
