# Source maps

An instrumented module must not lose its stack traces. The exports tap is
built around that:

- **Fast path** (every requested binding already reassignable): the module
  body is never restructured. For ESM the tap only **appends** snippets; for
  CJS the body is enclosed in the [evaluation wrap](#the-cjs-evaluation-wrap)
  (see below) whose inserted prefix carries no newline. Either way existing
  line numbers, and therefore any existing source map, stay valid — no new
  map is needed or emitted, except the one case the wrap corrects for.
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

## The CJS evaluation wrap

A CJS module's tap is spliced into an arrow IIFE (`;(() => { <body>\n})();
<tap>` — [how-it-works](how-it-works.md) has the why). The 10-character
prefix contains no newline, so every line keeps its number and a mapped
multi-line module resolves exactly as before: only the insertion line's
columns shift, and in ordinary code that line is a comment, a directive, or
a short first statement no map lookup depends on.

A **production-minified bundle breaks that bargain**: the whole module is
its first line, its map is a single dense run of line-0 column segments,
and a 10-column shift lands every stack-frame lookup on the _wrong
segment_ — wrong original function, wrong original line. js-yaml's shipped
`dist/js-yaml.min.js` reported `state` where `readFlowCollection` threw.

So the apply step corrects the module's **own** map (`cjsWrapMap` in
`core/cjs-wrap.mts`), without parsing anything:

- The map is discovered from the module's last `//# sourceMappingURL=`
  comment — an inline base64 data URL, or an external file resolved next to
  the module.
- The insertion line's **first** mapped segment moves right by the prefix
  width. Within a mappings line every later column is a delta off the
  previous segment, so that single VLQ edit reflows the entire line; no map
  library, no full decode.
- Delivery reuses what the rewrite path already had: the runtime hook
  inlines the corrected map as a trailing data URL (the **last**
  `sourceMappingURL` comment in a file wins, so the module's stale comment
  is overridden), and at build time the map is returned to the bundler,
  which chains it itself.
- When nothing mapped moves — no map at all, or the insertion line has no
  segments because a banner comment owns it (axios's minified dist) — the
  result stays `map: null` and the output is byte-identical to a plain
  splice.

The correction is pure core, so both engines share it and the instrumented
bytes (map included) stay identical whichever engine produced them. One
caveat: inlining re-homes an external map, so its `sources` now resolve
relative to the module file rather than the map file — the same place
whenever the two share a directory, which is where build tools put them.

[`__test__/cjs-minified-map.spec.ts`](../__test__/cjs-minified-map.spec.ts)
pins all of this against the real shipped js-yaml and axios artifacts:
stack frames of the wrapped minified bundle under `--enable-source-maps`
are asserted identical to the unwrapped module's, through the runtime hook
and build delivery alike.

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
