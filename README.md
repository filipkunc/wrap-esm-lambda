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
| `node runtime.mjs` | 25.7 ± 2.0 | 22.0 | 33.3 | 1.00 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 177.5 ± 6.6 | 168.6 | 188.9 | 6.91 ± 0.60 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 37.4 ± 2.2 | 32.8 | 46.3 | 1.46 ± 0.14 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 70.4 ± 4.0 | 64.1 | 81.8 | 2.74 ± 0.26 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 42.5 ± 5.1 | 35.7 | 72.8 | 1.65 ± 0.24 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 48.7 ± 4.5 | 41.1 | 59.5 | 1.90 ± 0.23 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 26.6 ± 4.4 | 21.5 | 58.4 | 1.04 ± 0.19 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 334.9 ± 11.2 | 321.4 | 361.6 | 13.04 ± 1.10 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 217.7 ± 8.0 | 205.2 | 231.6 | 8.48 ± 0.73 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 78.9 ± 5.1 | 69.5 | 93.7 | 3.07 ± 0.31 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 67.4 ± 5.3 | 58.8 | 80.0 | 2.62 ± 0.29 |
