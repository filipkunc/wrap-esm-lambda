# `wrap-esm-lambda`

![https://github.com/filipkunc/wrap-esm-lambda/actions](https://github.com/filipkunc/wrap-esm-lambda/workflows/CI/badge.svg)

Based on [napi-rs/package-template](https://github.com/napi-rs/package-template).

## Usage

1. Run `yarn install` to install dependencies.
2. Run `yarn build` to build.
3. Run `yarn test` to run Node binding tests with [`ava`](https://github.com/avajs/ava)
4. Run `cargo fmt` before committing
5. Run `cargo test` to run Rust tests

### CI

CI tests against [`node@20`, `@node22`] x [`Linux`] matrix.
