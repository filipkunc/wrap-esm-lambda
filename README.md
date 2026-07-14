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

1. Run `pnpm install` to install dependencies.
2. Run `pnpm build` to build.
3. Run `pnpm test` to run Node binding tests with [`ava`](https://github.com/avajs/ava)
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

#### Composing the maps in Rust instead of `remapping`

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

### Hybrid instrumentation: runtime or build time

The same native transform can run at two very different moments, and the
[packages/](packages) workspaces build both shells around one shared core so
users pick per deployment — not per codebase:

- [`@wrap-esm-lambda/core`](packages/core) — the shared piece: one declarative
  config (`defineConfig`), one matcher, one `transformMatched` call. Because
  both shells delegate to it, the instrumented output is byte-identical
  whichever mode produced it.
- [`@wrap-esm-lambda/hooks`](packages/hooks) — **runtime**: a synchronous
  `registerHooks` load hook, activated with
  `node --import @wrap-esm-lambda/hooks/register` and a config path in
  `WRAP_ESM_LAMBDA_CONFIG`. Zero build changes; per the cold-start table the
  native transform keeps the overhead in the ~2 ms range.
- [`@wrap-esm-lambda/unplugin`](packages/unplugin) — **build time**: the same
  transform behind [unplugin](https://unplugin.unjs.io/), giving
  Vite/Rolldown, Rollup, esbuild, webpack and Rspack adapters from one file.
  Modules are wrapped before bundling (path matching still works) and the
  bundler composes the returned source map; the deployed artifact is
  pre-instrumented, so cold start pays nothing.

Every transformed module ends with a `/*! @wrap-esm-lambda instrumented */`
legal comment (bundlers keep those), and both shells skip sources that carry
it — enabling both modes at once never double-wraps.
[`__test__/hybrid.spec.ts`](__test__/hybrid.spec.ts) runs one fixture through
both modes end-to-end, checks the outputs match, and layers the runtime hook
on a build-time instrumented bundle to prove the guard.

### WebAssembly

1. Run `rustup target add wasm32-wasip1-threads` to install build target
2. Run `pnpm build --target wasm32-wasip1-threads` to create `.wasm` file

### CI

CI tests against [`node@22`, `node@24`, `node@26`] x [`Linux`] matrix.

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
library in-process, amortized over many calls (`pnpm bench` for the table,
`pnpm bench:chart` for the charts). The fastest and slowest approaches are
three orders of magnitude apart, so one linear axis squashes the fast group
into slivers and a log axis understates the gaps that matter. Instead there
are two linear charts with the exact value printed on each bar. The first
zooms into the approaches under 100 µs, where all the interesting differences
live:

```sh
pnpm bench:chart
```

![Transform latency chart, fast approaches](hooks/transformChart.svg 'Transform latency, approaches under 100 µs')

The second shows the whole field for scale:

![Transform latency chart, all approaches](hooks/transformChartAll.svg 'Transform latency, all approaches')

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
  (oxc ~27 µs vs acorn ~47 µs) is the parser/codegen difference, and oxc chained
  still lands near orchestrion's cached, no-map transform.
- `oxc.rs + map chained in Rust` produces the same chained map but composes it
  with `oxc_sourcemap` inside the addon instead of `remapping` in JS (see
  [Composing the maps in Rust](#composing-the-maps-in-rust-instead-of-remapping)).
  Skipping the JS compose and the wrap map's JSON round-trip across napi brings
  ~27 µs down to ~11 µs, faster than `acorn + source map` even though it also
  chains to the `.ts`.
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
