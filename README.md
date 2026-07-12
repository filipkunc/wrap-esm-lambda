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
