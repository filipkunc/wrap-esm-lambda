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
| `node runtime.mjs` | 33.4 ± 3.4 | 27.8 | 44.9 | 1.00 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 235.3 ± 18.5 | 215.8 | 284.4 | 7.03 ± 0.91 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 48.2 ± 4.1 | 40.1 | 65.4 | 1.44 ± 0.19 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 52.7 ± 3.9 | 45.1 | 64.3 | 1.57 ± 0.20 |
| `node --import ./sync-hooks-replace.mjs runtime.mjs` | 34.2 ± 5.1 | 26.7 | 55.7 | 1.02 ± 0.18 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 427.5 ± 15.7 | 406.2 | 459.8 | 12.78 ± 1.39 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 276.1 ± 13.9 | 259.3 | 300.7 | 8.26 ± 0.94 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 98.5 ± 5.7 | 91.6 | 114.3 | 2.95 ± 0.35 |
| `node --import ./register-async-hooks-replace.mjs runtime.mjs` | 81.1 ± 4.7 | 71.9 | 93.0 | 2.42 ± 0.28 |
