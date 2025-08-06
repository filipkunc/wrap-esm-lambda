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
| `node runtime.mjs` | 34.3 ± 3.5 | 27.9 | 45.5 | 1.00 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 228.4 ± 8.4 | 219.2 | 250.6 | 6.67 ± 0.73 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 49.3 ± 3.2 | 42.7 | 55.7 | 1.44 ± 0.18 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 56.2 ± 7.3 | 42.6 | 88.7 | 1.64 ± 0.27 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 34.6 ± 3.6 | 28.3 | 46.3 | 1.01 ± 0.15 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 437.4 ± 31.9 | 404.3 | 515.1 | 12.77 ± 1.61 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 277.7 ± 14.0 | 262.0 | 309.6 | 8.11 ± 0.93 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 104.0 ± 9.6 | 90.1 | 133.0 | 3.04 ± 0.42 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 83.4 ± 6.7 | 73.7 | 108.8 | 2.43 ± 0.32 |
