# `wrap-esm-lambda`

![https://github.com/filipkunc/wrap-esm-lambda/actions](https://github.com/filipkunc/wrap-esm-lambda/workflows/CI/badge.svg)

Based on [napi-rs/package-template](https://github.com/napi-rs/package-template).

## Usage

1. Run `yarn install` to install dependencies.
2. Run `yarn build` to build.
3. Run `yarn test` to run Node binding tests with [`ava`](https://github.com/avajs/ava)
4. Run `cargo fmt` and `cargo clippy` before committing
5. Run `cargo test` to run Rust tests

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

| Command | Mean [ms] | Min [ms] | Max [ms] | Relative |
|:---|---:|---:|---:|---:|
| `node runtime.mjs` | 20.9 ± 1.9 | 16.8 | 26.2 | 1.00 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 142.2 ± 4.1 | 134.0 | 148.2 | 6.81 ± 0.64 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 33.6 ± 2.6 | 27.9 | 39.2 | 1.61 ± 0.19 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 60.5 ± 3.6 | 54.6 | 70.5 | 2.90 ± 0.31 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 122.1 ± 6.9 | 110.9 | 143.1 | 5.85 ± 0.62 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 47.0 ± 5.2 | 39.1 | 63.4 | 2.25 ± 0.32 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 24.9 ± 3.8 | 18.0 | 36.0 | 1.19 ± 0.21 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 292.5 ± 7.8 | 282.0 | 305.5 | 14.01 ± 1.30 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 189.5 ± 6.0 | 177.1 | 197.6 | 9.08 ± 0.86 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 73.7 ± 7.0 | 62.0 | 98.1 | 3.53 ± 0.46 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 59.3 ± 4.7 | 49.9 | 69.5 | 2.84 ± 0.34 |

