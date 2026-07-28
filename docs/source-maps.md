# Source maps

An instrumented module must not lose its stack traces. The exports tap is
built around that:

- **Fast path** (every requested binding already reassignable): the module
  source is untouched — the tap only **appends** snippets. Existing line
  numbers, and therefore any existing source map, stay valid; no new map is
  needed or emitted.
- **Rewrite path** (`export const` demotion, anonymous defaults, re-export
  splits): the module is restructured, so the engine emits a v3 source map
  for the rewrite. The runtime shell inlines it as a
  `//# sourceMappingURL=` data URL (`inlineMap` in core's apply step), and
  Node's stack traces resolve through it; at build time the map is returned
  to the bundler, which chains it into its own pipeline.

A demotion changes one keyword per affected statement, so mapped positions
stay on their original lines — a `throw` on line 2 of the original resolves
to line 2 through the rewrite map. Both engines emit one:
[oxc](https://oxc.rs/) builds it in codegen (native side), the acorn engine
builds it from magic-string edits, and
[`__test__/engine-parity.spec.ts`](../__test__/engine-parity.spec.ts) pins
that positions in untouched code resolve to the original source either way.

## Chaining back to TypeScript

A rewritten module may itself be the output of an earlier transform — tsc's
`handler.js` carrying a `handler.js -> handler.ts` map. The rewrite map
alone would stop at `handler.js`, so both tap entry points
(`exportsTap`/`exportsTapFromBuffer`) accept an `upstreamMap`: the emitted
map is composed through it, and the final map reaches the original `.ts`.

The compose runs where each engine lives:

- **Native**: `oxc_sourcemap` token lookup inside the addon
  (`chain_source_maps` in `src/transform.rs`) — the rewrite map never
  leaves Rust, skipping a JSON serialize/re-parse round-trip across napi.
  The Rust unit test `test_exports_tap_chained_upstream_map` pins the
  chained map's `sources` at `handler.ts` with `sourcesContent` carried
  over.
- **Pure JS**: [`@jridgewell/remapping`](https://github.com/jridgewell/sourcemaps)
  (the maintained home of `@ampproject/remapping`) in the acorn engine
  (`packages/engine-acorn/src/sourcemaps.mts`). Tokens the upstream map has
  no mapping for are dropped by both, so the engines agree on chained-map
  semantics.

Historical note: this machinery was built for the original standalone
Lambda-handler wrap transform (`transformLambda*`), which measured ~1 µs
per emitted map and ~2.5x end-to-end savings for the in-Rust compose vs
`remapping`. That transform is gone — the tap's rewrite path inherited the
same codegen and chaining — and the research-phase story lives in
[history.md](history.md) and the repo's presentations.
