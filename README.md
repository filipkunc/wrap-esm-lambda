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

Example output:

```sh
Benchmark 1: node runtime.mjs
  Time (mean ± σ):      32.1 ms ±   3.3 ms    [User: 22.2 ms, System: 11.7 ms]
  Range (min … max):    26.0 ms …  42.2 ms    96 runs
 
Benchmark 2: node --import ./sync-hooks-babel.mjs runtime.mjs
  Time (mean ± σ):     226.5 ms ±  13.9 ms    [User: 229.5 ms, System: 48.6 ms]
  Range (min … max):   210.7 ms … 251.0 ms    13 runs
 
Benchmark 3: node --import ./sync-hooks-oxc.mjs runtime.mjs
  Time (mean ± σ):      49.1 ms ±  10.5 ms    [User: 40.7 ms, System: 14.6 ms]
  Range (min … max):    36.1 ms … 111.0 ms    55 runs
 
Benchmark 4: node --import ./sync-hooks-replace.mjs runtime.mjs
  Time (mean ± σ):      35.3 ms ±   4.0 ms    [User: 24.4 ms, System: 12.3 ms]
  Range (min … max):    28.6 ms …  43.7 ms    67 runs
 
Benchmark 5: node --import ./register-async-hooks-babel.mjs runtime.mjs
  Time (mean ± σ):     277.0 ms ±  24.6 ms    [User: 293.1 ms, System: 65.8 ms]
  Range (min … max):   232.5 ms … 316.8 ms    10 runs
 
Benchmark 6: node --import ./register-async-hooks-oxc.mjs runtime.mjs
  Time (mean ± σ):      91.5 ms ±  14.0 ms    [User: 85.7 ms, System: 21.8 ms]
  Range (min … max):    71.2 ms … 116.4 ms    30 runs
 
Benchmark 7: node --import ./register-async-hooks-replace.mjs runtime.mjs
  Time (mean ± σ):      74.7 ms ±   6.6 ms    [User: 65.5 ms, System: 19.1 ms]
  Range (min … max):    56.0 ms …  88.9 ms    50 runs
 
Summary
  node runtime.mjs ran
    1.10 ± 0.17 times faster than node --import ./sync-hooks-replace.mjs runtime.mjs
    1.53 ± 0.36 times faster than node --import ./sync-hooks-oxc.mjs runtime.mjs
    2.33 ± 0.32 times faster than node --import ./register-async-hooks-replace.mjs runtime.mjs
    2.85 ± 0.53 times faster than node --import ./register-async-hooks-oxc.mjs runtime.mjs
    7.06 ± 0.85 times faster than node --import ./sync-hooks-babel.mjs runtime.mjs
    8.63 ± 1.18 times faster than node --import ./register-async-hooks-babel.mjs runtime.mjs
```
