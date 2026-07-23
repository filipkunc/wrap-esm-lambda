# Source maps

Wrapping the handler shifts its lines: an exception then reports the position in
the transformed code, not the original file. `transformLambdaWithMap` fixes this
by asking oxc to also emit a source map, appended to the output as an inline
`//# sourceMappingURL=` data URL. The wrapped handler body keeps its original
spans, so under Node's `--enable-source-maps` a thrown error resolves to the
original line.

```js
import { transformLambdaWithMap } from 'wrap-esm-lambda'
const source = transformLambdaWithMap(originalSource, 'handler', 'WrapAwsLambda', 'handler.mjs')
```

A runnable before/after demo is in [hooks/sourcemap-demo](../hooks/sourcemap-demo):

```sh
./hooks/sourcemap-demo/run.sh
```

The handler throws on line 11, but codegen strips the blank lines above it. Without
a map the stack points at line 4 (a comment); with the oxc map it points back at
line 11:

```
=== WITHOUT source map (plain transformLambda) ===
Error: boom for 42
    at handler-throws.mjs:4:8

=== WITH oxc source map (transformLambdaWithMap) ===
Error: boom for 42
    at handler-throws.mjs:11:9
```

Emitting the map is cheap: on a small handler the transform goes from ~2.9 µs to
~4.2 µs, so even with a map oxc is faster than acorn without one.

## Chaining back to TypeScript

If the handler started as TypeScript, `tsc` already produced `handler.js` plus a
`handler.js` -> `handler.ts` map. Our wrap adds a second step, so its map only
reaches `handler.js`. To get an exception all the way back to the `.ts`, compose
the two maps. oxc's map is `transformed -> handler.js`; chain it through the tsc
map with [`@ampproject/remapping`](https://github.com/ampproject/remapping)
(synchronous, so it works inside a `registerHooks` load hook).
`transformLambdaWithMapObject` returns the raw map for this:

```js
import remapping from '@ampproject/remapping'
import { transformLambdaWithMapObject } from 'wrap-esm-lambda'

const { code, map } = transformLambdaWithMapObject(jsSource, 'handler', 'WrapAwsLambda', 'handler.js')
const chained = remapping(map, (file) => (file.endsWith('handler.js') ? tscMap : null)).toString()
// `chained` now maps transformed -> handler.ts; inline it as a data URL
```

Demo in [hooks/sourcemap-ts-demo](../hooks/sourcemap-ts-demo) (`./run.sh` compiles
the `.ts` first). The handler throws on line 15 of `handler.ts`; without chaining
the stack stops at the generated `handler.js`, with chaining it reaches the `.ts`:

```
=== wrap with NON-chained map (transformed -> handler.js only) ===
Error: boom for 42
    at handler.js:4:11

=== wrap with CHAINED map (transformed -> handler.js -> handler.ts) ===
Error: boom for 42
    at handler.ts:15:9
```

The compose costs ~22 µs on top of the transform (the map JSON round-trips through
`remapping`), still well under a single Babel transform and paid once per module.

## Composing the maps in Rust instead of `remapping`

The compose itself doesn't need JS at all: `transformLambdaWithChainedMap` takes
the upstream tsc map JSON and traces the wrap map through it in Rust, using
`oxc_sourcemap`'s token lookup (the same trace `remapping` performs). The wrap
map never leaves Rust — no serialize-to-JSON, cross napi, re-parse round-trip —
so the whole wrap-and-chain runs in one call:

```js
import { transformLambdaWithChainedMap } from 'wrap-esm-lambda'

// tscMap: the handler.js -> handler.ts map tsc emitted
const source = transformLambdaWithChainedMap(jsSource, 'handler', 'WrapAwsLambda', 'handler.js', tscMap)
// `source` has an inline map already reaching handler.ts
```

(`transformLambdaWithChainedMapObject` returns `{ code, map }` instead of
inlining, mirroring `transformLambdaWithMapObject`.)

This is ~2.5x faster end-to-end than composing with `remapping`: ~11 µs vs
~27 µs for wrap + chain (the compose step drops from ~23 µs to ~7 µs). The
result is byte-for-byte equivalent in effect — the demo's third variant
(`sync-hooks-oxc-ts-rust.mjs`) resolves the same `handler.ts:15:9`:

```
=== wrap with CHAINED map composed in Rust (oxc_sourcemap, no remapping) ===
Error: boom for 42
    at handler.ts:15:9
```
