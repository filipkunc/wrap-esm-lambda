# `wrap-esm-lambda`

![https://github.com/filipkunc/wrap-esm-lambda/actions](https://github.com/filipkunc/wrap-esm-lambda/workflows/CI/badge.svg)

## Wrapping AWS Lambda ESM `handler`

The problem: How to transform AWS Lambda `handler` below?

```js
// input.js
export const handler = async (event) => {
  return 'Hi from AWS Lambda'
}
```

To the following, notice the `WrapAwsLambda` wrapper:

```js
// transformed.js
export const handler = WrapAwsLambda(async (event) => {
  return 'Hi from AWS Lambda'
})
```

Wrapping uses [async and sync loader hooks from Node.js](https://nodejs.org/api/module.html#customization-hooks).

This library uses [napi.rs](https://napi.rs/) and [oxc.rs](https://oxc.rs/).
For comparison the minimal wrapping code is re-implemented using [Babel](https://babeljs.io/), [Acorn](https://github.com/acornjs/acorn), [swc.rs](https://swc.rs/) and [orchestrion-js](https://github.com/nodejs/orchestrion-js) (via a custom `addTransform` operator, plus its stock `diagnostics_channel` tracing transform for reference).

## Usage

1. Run `yarn install` to install dependencies.
2. Run `yarn build` to build.
3. Run `yarn test` to run Node binding tests with [`ava`](https://github.com/avajs/ava)
4. Run `cargo fmt` and `cargo clippy` before committing
5. Run `cargo test` to run Rust tests

### Source maps

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

A runnable before/after demo is in [hooks/sourcemap-demo](hooks/sourcemap-demo):

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

#### Chaining back to TypeScript

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

Demo in [hooks/sourcemap-ts-demo](hooks/sourcemap-ts-demo) (`./run.sh` compiles
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

### WebAssembly

1. Run `rustup target add wasm32-wasip1-threads` to install build target
2. Run `yarn build --target wasm32-wasip1-threads` to create `.wasm` file

### CI

CI tests against [`node@20`, `@node22`] x [`Linux`] matrix.

### Benchmarks

Two things are measured. The first is process **cold start**: how much each
hooking strategy adds to `node runtime.mjs`, timed with
[`hyperfine`](https://github.com/sharkdp/hyperfine). The table in
[releases](https://github.com/filipkunc/wrap-esm-lambda/releases) and the chart
below come from this.

To run it locally use:

```sh
sudo apt update && sudo apt install -y hyperfine
cd hooks && ./bench_hooks.sh
```

Example output is in [hooks/benchTable.md](hooks/benchTable.md):

![Cold start benchmark chart](hooks/benchChart.svg 'Cold start benchmark chart')

The second is raw **transform latency**: how long a single wrap costs each
library in-process, amortized over many calls (`yarn bench` for the table,
`yarn bench:chart` for the chart). The axis is logarithmic because the fastest
and slowest approaches are three orders of magnitude apart.

```sh
yarn bench:chart
```

![Transform latency chart](hooks/transformChart.svg 'Transform latency chart')

Notes on the transform-latency comparison:

- `regex` is a string replace with no parser, so it is fastest but only handles
  the shapes its pattern anticipates. `oxc.rs` is the fastest approach that
  actually parses to an AST.
- The `+ source map` bars emit a map that reaches the wrapped JS. oxc's native
  map costs only ~1 µs, so `oxc.rs + source map` is still faster than acorn with
  no map. `acorn + source map` (astring feeding a
  [`@jridgewell/source-map`](https://github.com/jridgewell/sourcemaps) generator)
  roughly doubles acorn's time — the map is nearly free when the codegen builds
  it in Rust, but a real per-node cost through a JS generator.
- The `+ map chained to .ts` bars go further: they transpile a TypeScript handler
  and compose the wrap map with tsc's map via `@ampproject/remapping` so the
  result reaches the original `.ts` (see [Source maps](#source-maps)). The
  compose is the same parser-independent step for both, so the gap between them
  (oxc ~28 µs vs acorn ~48 µs) is the parser/codegen difference, and oxc chained
  still lands near orchestrion's cached, no-map transform.
- `orchestrion (cached selector)` memoizes orchestrion's per-call
  `esquery.parse`, which its shipped code recompiles on every `transform()`.
  That one change accounts for the ~10x gap to `orchestrion (minimal wrap)`.
- `orchestrion (tracing)` is orchestrion's stock output (a full
  `diagnostics_channel` wrapper), so it does more work than the minimal
  `wrapper(...)` the others emit.
- `swc.rs (wasm)` reflects the cost of calling the swc plugin across the wasm
  boundary, not swc's native transform speed.

### Frida hooking

The https://frida.re/ is used for hooking into `open`, `read` and `uv_fs_stat` against Node v22.18.0.  
Problematic function is `uv_fs_fstat` which does not have stable definition of `libuv_sys2::uv_fs_t` struct!
