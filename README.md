# `wrap-esm-lambda`

![https://github.com/filipkunc/wrap-esm-lambda/actions](https://github.com/filipkunc/wrap-esm-lambda/workflows/CI/badge.svg)

## Wrapping AWS Lambda ESM `handler`

The problem: How to transform AWS Lambda `handler` below?

```js
// input.js
export const handler = async(event) => {
    return "Hi from AWS Lambda";
};
```

To the following, notice the `WrapAwsLambda` wrapper:

```js
// transformed.js
export const handler = WrapAwsLambda(async(event) => {
    return "Hi from AWS Lambda";
});
```

Wrapping uses [async and sync loader hooks from Node.js](https://nodejs.org/api/module.html#customization-hooks).

This library uses [napi.rs](https://napi.rs/) and [oxc.rs](https://oxc.rs/).
For comparison the minimal wrapping code is re-implemented using [Babel](https://babeljs.io/), [Acorn](https://github.com/acornjs/acorn) and [swc.rs](https://swc.rs/).

## Usage

  1. Run `yarn install` to install dependencies.
  2. Run `yarn build` to build.
  3. Run `yarn test` to run Node binding tests with [`ava`](https://github.com/avajs/ava)
  4. Run `cargo fmt` and `cargo clippy` before committing
  5. Run `cargo test` to run Rust tests

### WebAssembly

  1. Run `rustup target add wasm32-wasip1-threads` to install build target
  2. Run `yarn build --target wasm32-wasip1-threads` to create `.wasm` file

### CI

CI tests against [`node@20`, `@node22`] x [`Linux`] matrix.

### Benchmarks

The benchmark table in [releases](https://github.com/filipkunc/wrap-esm-lambda/releases) is generated via
[`hyperfine`](https://github.com/sharkdp/hyperfine).

To run it locally use:

```sh
sudo apt update && sudo apt install -y hyperfine
cd hooks && ./bench_hooks.sh
```

Example output in `hooks/benchTable.md`:

| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 24.4 ± 1.2 | 22.6 | 31.1 | 1.00 | 43.82 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 184.4 ± 3.7 | 177.7 | 191.9 | 7.56 ± 0.41 | 79.12 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 37.8 ± 0.9 | 36.0 | 40.0 | 1.55 ± 0.09 | 57.82 |
| `node --import ./sync-hooks-oxc-frida.mjs runtime.mjs` | 36.5 ± 0.9 | 35.2 | 39.6 | 1.50 ± 0.08 | 56.62 |
| `LD_PRELOAD=../wrap-esm-lambda.linux-x64-gnu.node node runtime.mjs` | 26.8 ± 0.7 | 25.4 | 29.1 | 1.10 ± 0.06 | 49.23 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 70.7 ± 2.4 | 68.1 | 77.5 | 2.90 ± 0.17 | 63.19 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 127.9 ± 2.6 | 123.0 | 132.2 | 5.24 ± 0.28 | 370.79 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 48.0 ± 1.0 | 46.3 | 51.1 | 1.97 ± 0.11 | 54.12 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 26.9 ± 1.1 | 24.7 | 32.5 | 1.10 ± 0.07 | 44.25 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 341.4 ± 2.3 | 339.7 | 346.9 | 14.00 ± 0.71 | 113.74 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 222.6 ± 3.1 | 216.4 | 227.3 | 9.13 ± 0.48 | 88.41 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 74.2 ± 1.8 | 72.0 | 80.9 | 3.04 ± 0.17 | 68.46 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 60.6 ± 1.6 | 58.2 | 64.3 | 2.48 ± 0.14 | 59.57 |

### Frida hooking

The https://frida.re/ is used for hooking into `open`, `read` and `uv_fs_stat` against Node v22.18.0.  
Problematic function is `uv_fs_fstat` which does not have stable definition of `libuv_sys2::uv_fs_t` struct!
