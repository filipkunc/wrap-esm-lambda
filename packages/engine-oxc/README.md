# `@wrap-esm-lambda/engine-oxc`

The native transform engine for wrap-esm-lambda, implemented in Rust with
[oxc](https://oxc.rs/) and exposed to Node.js through [napi-rs](https://napi.rs/).

Most applications should install `@wrap-esm-lambda/core` or
`@wrap-esm-lambda/hooks`; those packages select this engine by default and can
fall back to `@wrap-esm-lambda/engine-acorn` when a native binding is unavailable.

From the repository root, `pnpm build` builds this package and generates its
JavaScript loader and declarations. Rust-only work can run `cargo test` or
`cargo clippy` from this directory.
