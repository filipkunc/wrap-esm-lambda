# `@wrap-esm-lambda/engine-oxc`

The native transform engine for wrap-esm-lambda, implemented in Rust with
[oxc](https://oxc.rs/) and exposed to Node.js through [napi-rs](https://napi.rs/).

Most applications should install `@wrap-esm-lambda/core` or
`@wrap-esm-lambda/hooks`; those packages select this engine by default and can
fall back to `@wrap-esm-lambda/engine-acorn` when a native binding is unavailable.

From the repository root, `pnpm build` builds this package and generates its
JavaScript loader and declarations. Rust-only work can run `cargo test` or
`cargo clippy` from this directory.

For an end-to-end native debugging check, open the repository root in VS Code
and choose **Debug Rust addon (smoke)**. Its pre-launch task creates a debug
build with symbols and compiles the JavaScript workspace packages. Set a
breakpoint on `exports_tap` in [`src/lib.rs`](src/lib.rs); CodeLLDB binds it when
the addon loads and stops in the engine-parity spec. The focused-file variant
is useful after the smoke path works. See the repository's
[VS Code debugging guide](../../CONTRIBUTING.md#debugging-in-vs-code).
