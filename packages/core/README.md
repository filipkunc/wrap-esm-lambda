# `@wrap-esm-lambda/core`

Shared core of the hybrid instrumentation setup: one declarative config
(`defineConfig`), one matcher (`createMatcher`), and one transform
(`transformMatched`) built on the native `wrap-esm-lambda` oxc addon.

Both shells consume this package, so the instrumented output is byte-identical
whichever mode produced it:

- [`@wrap-esm-lambda/hooks`](../hooks) — runtime, via `module.registerHooks`
- [`@wrap-esm-lambda/unplugin`](../unplugin) — build time, via a bundler plugin

`transformMatched` also appends a sentinel comment and skips sources that
already carry it, so enabling both modes at once never double-wraps.

> Scaffold status: sources import the napi core by relative path; this becomes
> a real `wrap-esm-lambda` dependency once the repo is split into workspaces.
