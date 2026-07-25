# `wrap-esm-lambda`

![https://github.com/filipkunc/wrap-esm-lambda/actions](https://github.com/filipkunc/wrap-esm-lambda/workflows/CI/badge.svg)

**Declarative patching for Node.js modules — ESM, CJS, dual packages and core
builtins — delivered at runtime or at build time from one config.**

You describe _what_ to patch (package name, semver range, files, exported
bindings) and write an ordinary imperative patch function. The toolkit appends
a generic **exports tap** to the matched module's source (a native
[oxc](https://oxc.rs/) transform via [napi.rs](https://napi.rs/)), and your
function receives the module's live bindings as get/set accessors — the same
reach `Module._load` monkey-patching ever had, but working for `import` and
`require()` alike, including on the Node minors where the classic patch points
were [broken](docs/history.md).

The project began as an experiment in wrapping AWS Lambda ESM handlers — that
transform is still here ([below](#the-original-transform-wrapping-a-lambda-handler)) —
and grew into a general instrumentation toolkit.

## Quick start

Patch express so every request records its matched route template
(`/api/users/:id` — OTel's `http.route`), without touching app code.

**1. Write the patch** — plain imperative code against live objects:

```js
// patches/http-route.mjs
export function patchExpressRoute({ application }) {
  const origHandle = application.handle
  application.handle = function (req, res, ...rest) {
    const origEnd = res.end
    res.end = function (...args) {
      const route = `${req.baseUrl ?? ''}${req.route?.path ?? ''}`
      if (route) console.log('http.route =', route)
      return origEnd.apply(this, args)
    }
    return origHandle.call(this, req, res, ...rest)
  }
}
```

**2. Declare where it applies:**

```js
// wrap.config.mjs
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
      patch: { name: 'patchExpressRoute', from: './patches/http-route.mjs' },
      bindings: ['application'],
    },
  ],
  import.meta.url, // `from` specifiers resolve relative to this file
)
```

**3. Deliver it** — either at **runtime** (zero build changes, Node >= 22.15):

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
```

…or at **build time** (zero runtime cost, any bundler unplugin supports):

```js
// esbuild — same config file
import { build } from 'esbuild'
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.mjs'

await build({
  entryPoints: ['app.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  // express's CJS graph requires node builtins; esbuild's ESM output needs
  // the standard createRequire shim for those (unrelated to the plugin)
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [esbuildPlugin(config)],
})
```

Both modes produce **byte-identical** instrumented output, and a sentinel
comment guards against double-patching when they're combined. A runnable copy
of this exact setup lives in [examples/express-route](examples/express-route):

```sh
pnpm --filter example-express-route start
```

## How it works

The matched module is parsed once (oxc, full AST) and every requested
binding is validated against its statically visible exports — a missing
export is a hard error, the version-drift alarm. Then the tap is **tiered**:

- **Fast path** — when every requested binding is already a reassignable
  local (function/class/`let`/`var` declarations, list exports of mutable
  locals: the common case for classes like smithy's `Client`), the tap only
  **appends** a snippet calling your patch function with get/set accessors
  over the live bindings. The source is untouched, existing source maps stay
  valid, and on the runtime path the bytes never leave UTF-8.
- **Rewrite path** — shapes that cannot be rebound as written are
  **restructured** through one AST rewrite + codegen (with a source map):
  `export const` is demoted to `let` (destructuring patterns included), an
  anonymous `export default` is named into a local, and re-exports —
  `export { a as b } from`, `export * as ns from`, import-backed list
  exports — are split into an import plus a rebindable local. Even a bare
  `export * from` resolves: the transform walks the star sources' files to
  find the provider — following bare specifiers (`export * from "pkg"`)
  through full import-style package resolution
  ([oxc_resolver](https://docs.rs/oxc_resolver) natively, its JS twin in the
  acorn engine) — then appends a shadow export (explicit exports shadow
  `export *`, so this one is append-only). Only modules that need a
  rewrite pay for one; what stays loud: ambiguous star names, stars into
  CJS, stars into packages that are not installed.

Either way the patch call runs at the end of the module's own evaluation:
after its definitions exist, before any importer sees them.

- `bindings.X` reads the live value; mutating it
  (`X.prototype.send = ...`) works everywhere.
- `bindings.X = wrapped` **rebinds** the export — an ESM live binding
  reassignment or a `module.exports.X` write. The reserved
  `'module.exports'` binding rebinds a CJS module whose export _is_ the API
  (fastify's factory); `'default'` taps a default export.
- ESM and CJS get mode-specific snippets; the CJS-or-ESM decision reproduces
  Node's own format rules at runtime (extension, then nearest package.json
  `"type"`), and falls back to the same **syntax detection** bundlers
  themselves use at build time, where no format hint exists — so a pure-CJS
  express, the AWS SDK's `"type"`-less ESM `dist-es`, and the two trees of a
  dual package like hono each land on their real tap in both shells.
- Patch delivery differs per mode: at build time a static import of your
  patch module is appended and bundled (a `require()` call when the patched
  module is CJS — appended `import` syntax would flip its format under the
  bundler's own detection); at runtime the register entry preloads patch
  functions into a global registry the tap reads (a hook-overridden CJS
  source cannot serve an injected `require`).

Full rules — call timing, rebinding edges, dependency dos and don'ts, failure
modes — live in the
[patch author contract](packages/core/README.md#patch-author-contract), each
backed by a test.

### Why not `Module._load` / a loader proxy?

Three mechanism classes exist for reaching a module's exports, and each has a
blind spot ([full comparison](docs/comparisons.md), with tests over identical
targets):

- **`Module._load` patching** (require-in-the-middle lineage) never sees
  `import` of a builtin, historically lost `import`-ed CJS whenever Node's
  loader shifted ([the breakage trail](docs/history.md)), and has no
  build-time story.
- **Loader proxies** ([import-in-the-middle](https://github.com/nodejs/import-in-the-middle))
  never see a pure `require()` chain — the path the real AWS SDK takes under
  plain `node`.
- **Body-rewriting transforms** ([orchestrion-js](https://github.com/nodejs/orchestrion-js))
  can reach non-exported internals, but user code only _observes_ events —
  and the transform costs ~100x more per module.

The exports tap patches both module systems from one declarative entry, works
at build time too, and never touches `Module._load` — the
[interplay matrix](hooks/interplay-matrix) shows it behaving identically on
every Node 22/24/26 rung, including the minors where sync hooks and
`Module._load` miscomposed.

## The packages

| package                                                  | role                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@wrap-esm-lambda/core`](packages/core)                 | config (`defineConfig`/`definePatches`), matcher, apply step; the [patch author contract](packages/core/README.md#patch-author-contract)       |
| [`@wrap-esm-lambda/hooks`](packages/hooks)               | **runtime** shell: synchronous `registerHooks` load hook + eager builtin patching, activated via `node --import`                               |
| [`@wrap-esm-lambda/unplugin`](packages/unplugin)         | **build-time** shell: one [unplugin](https://unplugin.unjs.io/), adapters for Vite/Rolldown, Rollup, esbuild, webpack, Rspack                  |
| [`wrap-esm-lambda`](index.d.ts) (repo root)              | the native oxc addon — the default engine: `exportsTap*` (the tap) and `transformLambda*` (the handler wrap), with zero-copy `Buffer` variants |
| [`@wrap-esm-lambda/engine-acorn`](packages/engine-acorn) | the pure-JS engine (acorn + magic-string), same surface and byte-identical snippets — select with `WRAP_ESM_LAMBDA_ENGINE=acorn`               |

The `core` source mirrors the pipeline a patch travels:
[`config.mjs`](packages/core/src/config.mjs) (the entry shapes) ->
[`match.mjs`](packages/core/src/match.mjs) (which entries apply to which
module) -> [`format.mjs`](packages/core/src/format.mjs) (the CJS-or-ESM
decision) -> [`apply.mjs`](packages/core/src/apply.mjs) (entries ->
instrumented source), plus [`registry.mjs`](packages/core/src/registry.mjs)
(the runtime patch-registry contract).

## Config reference

A config is a list of entries; two kinds exist and mix freely.

### Patch entries — the exports tap

```ts
{
  module: {
    name: '@smithy/core',        // package name (nearest package.json) — or a builtin ('node:os')
    versionRange: '>=3 <5',      // optional semver gate (builtins: gates on process.versions.node)
    files: ['dist-es/submodules/client/smithy-client/client.js', 'dist-cjs/submodules/client/index.js'],
                                 // optional path suffixes; omit = every file of the package
  },
  patch: { name: 'patchSmithyClient', from: '/abs/path/patches/aws.ts' },
  bindings: ['Client'],          // exports handed to the patch; 'module.exports' rebinds the whole CJS export
}
```

- `patch.from` may be relative to the config file, a bare package specifier,
  a `file://` URL or an absolute path — pass `import.meta.url` as the second
  argument of `defineConfig`/`definePatches` and everything is resolved to an
  absolute path at definition time (resolution rules in the
  [patch author contract](packages/core/README.md#patch-author-contract)).
  TypeScript patch files ride on Node's type stripping at runtime and on the
  bundler at build time.
- **Builtin targets** (`node:http`, `os`, ...) have no source to transform,
  so each shell reaches them through what it owns. The runtime shell patches
  their exports object **eagerly at preload**, before any user code loads.
  The build shell owns module **resolution** instead: every configured
  builtin specifier is aliased to a generated wrapper module that patches
  the real exports object via `process.getBuiltinModule` (Node >= 22.3
  where the bundle runs) and re-exports the patched bindings. In both modes
  `require()`, ESM default import and ESM named import all observe the
  patch, and a shared guard keeps the hybrid combination single-patched.
  Builtin entries reject `files`; `versionRange` gates on the running Node
  at preload and on the building Node at bundle time.
- Validation is loud: a requested binding missing from an ESM module (or a
  builtin) is a hard error, and a rebind that cannot take effect (getter-only
  CJS exports of a sloppy-mode bundle) throws instead of silently no-opping.

### Wrap entries — the original handler wrap

```ts
{
  match: 'handler.mjs',                                              // string suffix or RegExp on the file path
  handler: 'handler',                                                // exported const to wrap
  wrapper: { name: 'WrapAwsLambda', from: '/opt/nodejs/wrap.mjs' },  // identifier (+ optional import) to wrap it with
}
```

This rewrites `export const handler = ...` into
`export const handler = WrapAwsLambda(...)` at the AST level, with source
maps that keep stack traces pointing at the original lines (see
[docs/source-maps.md](docs/source-maps.md)).

## Shipping instrumentation as a package

A config is code, and `from` specifiers resolve against the config file — so
patch code, config and activation ship together as **one ordinary npm
package**, the way an APM vendor distributes instrumentation:

```
your-apm/
  package.json          exports: { "./register": ..., "./config": ... }
  src/patches/*.mjs     the patch functions (no dependency on this toolkit)
  src/config.mjs        definePatches([...], import.meta.url)
  src/register.mjs      import { registerConfig } from '@wrap-esm-lambda/hooks'
                        import config from './config.mjs'
                        await registerConfig(config)
```

The app installs the package and the whole runtime integration is one flag —
no config file, no env var:

```sh
node --import your-apm/register app.mjs
```

Alternatively `WRAP_ESM_LAMBDA_CONFIG` accepts a package specifier (resolved
from the app, like any dependency):

```sh
WRAP_ESM_LAMBDA_CONFIG=your-apm/config node --import @wrap-esm-lambda/hooks/register app.mjs
```

…and the same installed config drives build-time delivery through the
unplugin adapters. Because entries are plain data, an app composes several
instrumentation packages by concatenating their entries. The runnable version
of this pattern is [examples/function-logger](examples/function-logger) — a
before/after call logger with exception capture (logged and rethrown),
consumed by [examples/function-logger-app](examples/function-logger-app) and
verified end-to-end (both runtime activations plus the bundled build) by
[`__test__/packaging.spec.ts`](__test__/packaging.spec.ts).

## Worked examples

The test suite doubles as a recipe book — each spec runs the real package:

| target                             | what it shows                                                                                                                                                                                                                                       | spec                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **AWS SDK** (`@smithy/core`)       | one entry intercepts every `@aws-sdk/client-*` operation via `Client#send` — runtime hook on the SDK's bundled `dist-cjs`, esbuild on its `dist-es`, same patch                                                                                     | [`aws.spec.ts`](__test__/aws.spec.ts)               |
| **express** (pure CJS)             | tapping named `module.exports` properties; both `require('express')` and `import express` see the patch, and the same config lands through esbuild at build time                                                                                    | [`frameworks.spec.ts`](__test__/frameworks.spec.ts) |
| **fastify** (CJS, callable export) | rebinding the whole export via the reserved `'module.exports'` binding — wrapping the factory itself, in both shells                                                                                                                                | [`frameworks.spec.ts`](__test__/frameworks.spec.ts) |
| **hono** (dual package)            | one entry covering both dist trees; _target the defining module, not the barrel_; where rebinding meets bundled-CJS reality and fails loudly instead of silently                                                                                    | [`frameworks.spec.ts`](__test__/frameworks.spec.ts) |
| **`http.route` capture**           | the actual APM work: per-request route _templates_ for express/fastify/hono, mirroring each opentelemetry-js-contrib mechanism, delivered declaratively                                                                                             | [`http-route.spec.ts`](__test__/http-route.spec.ts) |
| **builtins** (`node:os`)           | eager preload patching at runtime, a resolution-aliased wrapper module at build time — require, default import and named import all observe it either way, single-patched when combined                                                             | [`patch.spec.ts`](__test__/patch.spec.ts)           |
| **rewrite shapes**                 | `export const` (the Lambda handler shape), destructured consts, anonymous `export default`, re-export barrels, `export * as ns` and bare `export *` chains — relative and bare package specifiers alike — all rebound, runtime and build mode alike | [`tap-shapes.spec.ts`](__test__/tap-shapes.spec.ts) |
| **hybrid**                         | runtime and build mode produce identical output; the sentinel prevents double-wrapping when both are on                                                                                                                                             | [`hybrid.spec.ts`](__test__/hybrid.spec.ts)         |
| **packaging**                      | instrumentation as one installed npm package (patches + config + register entry): `--import your-apm/register`, package-specifier configs, and the same packaged config bundled at build time                                                       | [`packaging.spec.ts`](__test__/packaging.spec.ts)   |
| **mechanics & footguns**           | emission shapes, loud failures, version gating, patch dependency rules (including the one documented divergence between modes)                                                                                                                      | [`patch.spec.ts`](__test__/patch.spec.ts)           |

For observe-only needs on core modules, Node's own
[`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
tracing channels are the sanctioned alternative — the eager patch is for when
you need to wrap or rebind.

The full field notes on each of these — the per-shape lessons (target the
defining module, not the barrel; where rebinding meets bundled-CJS reality),
the `http.route` mechanisms, and the builtin eager-patch design — live in
[docs/real-packages.md](docs/real-packages.md).

## The original transform: wrapping a Lambda handler

The problem this repo started with — transform:

```js
// input.js
export const handler = async (event) => {
  return 'Hi from AWS Lambda'
}
```

into:

```js
// transformed.js
export const handler = WrapAwsLambda(async (event) => {
  return 'Hi from AWS Lambda'
})
```

The native addon exposes this directly (`transformLambda`,
`transformLambdaWithMap`, `transformLambdaWithChainedMap`, buffer-input
variants — see [index.d.ts](index.d.ts)), and a wrap entry does it
declaratively through either shell. Stack traces survive: oxc emits a source
map for ~1 µs, and the map can be chained all the way back to an original
`.ts` — composed in Rust without leaving the addon. Details, demos and
numbers: [docs/source-maps.md](docs/source-maps.md).

For comparison the minimal wrapping code is re-implemented with
[Babel](https://babeljs.io/), [Acorn](https://github.com/acornjs/acorn),
[swc.rs](https://swc.rs/) and
[orchestrion-js](https://github.com/nodejs/orchestrion-js) — the benchmark
story lives in [docs/benchmarks.md](docs/benchmarks.md).

## Failure policy: what happens when instrumentation cannot do its job

Instrumentation sits in the load path of every module of a process it does not
own, so the question that decides whether it is deployable is not "does the
patch work" but "what happens when it doesn't" — a binding renamed in a
dependency bump, a patch function with a bug in it, a platform with no
prebuilt addon.

The rule: **fail soft wherever partial degradation exists, stay loud where
there is nothing to degrade to.** Downstream of a valid config, every failure
costs exactly what it has to and no more.

| what fails                                       | what it costs                                       |
| ------------------------------------------------ | --------------------------------------------------- |
| the native addon cannot be loaded                | the process runs on the pure-JS acorn engine        |
| a patch module will not import                   | that one entry drops; the other entries still apply |
| a requested binding is gone (version drift)      | that one module loads untouched                     |
| a patch function throws                          | that one patch call; the patched module still loads |
| a builtin's binding moved                        | that one builtin patch                              |
| `module.registerHooks` is missing (Node < 22.15) | the load hook; eager builtin patches still apply    |
| the config cannot be found or loaded             | **startup** — loud, on purpose (see below)          |

Every recovered failure reports once on stderr and is retrievable
programmatically, so "is this process fully instrumented?" has an answer:

```js
import { instrumentationFailures } from '@wrap-esm-lambda/core'
// { total: 1, entries: [{ what: "instrumenting file:///...", error: [Error] }] }
```

Three switches:

| variable                    | effect                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRAP_ESM_LAMBDA_DISABLE=1` | kill switch: no hooks, no patches, no transform — and the config is never resolved, the addon never loaded. Mitigates an incident without touching the app's start command. |
| `WRAP_ESM_LAMBDA_STRICT=1`  | every recovered failure throws instead. What CI runs; also how to find out why a patch is silently not applying.                                                            |
| `WRAP_ESM_LAMBDA_DEBUG=1`   | trace the decisions — engine bound, modules instrumented, entries skipped — to stderr.                                                                                      |

Two deliberate exceptions to the soft default. **Config resolution is loud**:
unlike a drifted binding it has nothing to degrade to, and an operator who
passed `--import` should learn at startup that they got no instrumentation, not
from absent telemetry hours later — `WRAP_ESM_LAMBDA_DISABLE=1` is the way to
say "not now". And **the build-time shell keeps throwing**: a failing build is
visible and cheap, a silently un-instrumented artifact is not.

Engine availability is not governed by strict mode but by
`WRAP_ESM_LAMBDA_ENGINE`: unset means "native, or the JS engine if the addon
cannot be loaded", while naming an engine (`oxc`, `acorn`) means "this one or
fail". CI names it, so a broken native build can never pass as a green acorn
run.

## Deploying on serverless platforms

Both AWS Lambda and Azure Functions can activate the runtime shell without
owning the node CLI (`NODE_OPTIONS=--import` / worker arguments), and the
[interplay matrix](hooks/interplay-matrix) verifies the bootstrap shape both
platforms use on every Node 22/24/26 rung — including the minors with broken
loader interplay that the platforms may still run. When the platform minor is
unverifiable and the risk budget is zero, the build-time shell delivers the
identical instrumentation with no runtime loader machinery at all. Full
analysis: [docs/serverless.md](docs/serverless.md).

## Development

1. `pnpm install` — install dependencies
2. `pnpm build` — build the native addon (`napi build --release`)
3. `pnpm test` — the test suite, on Node's built-in
   [test runner](https://nodejs.org/api/test.html) (`node --test`; TypeScript
   specs load through `@oxc-node/core`)
4. `cargo fmt` and `cargo clippy` before committing
5. `cargo test` — Rust tests

### WebAssembly

1. `rustup target add wasm32-wasip1-threads` to install the build target
2. `pnpm build --target wasm32-wasip1-threads` to create the `.wasm` file

### CI

Every supported Node major — `node@22`, `node@24`, `node@26` — runs the whole
suite three ways on Linux: on the native addon (with `WRAP_ESM_LAMBDA_ENGINE`
named explicitly, so a missing artifact fails the job instead of silently
falling back), on the pure-JS acorn engine, and on the WASI build. A fourth
lane runs with **no native artifact at all**, which is what a platform with no
prebuilt addon looks like — proving the degraded mode end to end rather than
only in a unit test.

The Rust side needs `rustc >= 1.95` (`rust-version` in `Cargo.toml`); CI floats
on stable.

## Performance

The headline numbers (details and methodology in
[docs/benchmarks.md](docs/benchmarks.md) and
[docs/comparisons.md](docs/comparisons.md)):

- The exports tap costs **~14 µs** per matched ESM module (full-AST parse +
  binding validation, all patch entries in one call) and **~2.4 µs** for a
  CJS tap — orchestrion's body-rewriting transform on the same file costs
  ~950–1200 µs. Shapes that
  force the tap's rewrite path (`export const`, anonymous defaults,
  re-exports) additionally pay one oxc codegen — the same machinery as the
  wrap transform, still microseconds.
- Runtime-hook cold start overhead on a real fixture app is **~29 ms**
  (half of which used to be the `semver` package, now replaced by an
  in-package range matcher), on par with import-in-the-middle's sync mode
  and ~3x cheaper than the off-thread loader OTel ships by default. Use a
  `.mjs` config (not `.ts`) where cold start matters.
- Module sources cross the napi boundary zero-copy as UTF-8 buffers on the
  runtime path; only the few-hundred-byte snippet comes back.
- A pure-JS engine ([`@wrap-esm-lambda/engine-acorn`](packages/engine-acorn),
  `WRAP_ESM_LAMBDA_ENGINE=acorn`) runs the whole setup with no native binary:
  same emitted code, ~6x slower on the parse-dominated tap (~86 µs vs ~14 µs
  per matched ESM module), ~14 ms more cold start — the measured JS-only vs
  JS + Rust trade-off, detailed in
  [docs/benchmarks.md](docs/benchmarks.md#js-only-vs-js--rust-the-two-engines).

## Design notes & further reading

- [docs/real-packages.md](docs/real-packages.md) — field notes from patching
  express, fastify, hono, the AWS SDK and builtins
- [docs/comparisons.md](docs/comparisons.md) — reach and cost vs
  orchestrion-js and import-in-the-middle, with tests over identical targets
- [docs/serverless.md](docs/serverless.md) — AWS Lambda / Azure Functions
  soundness, empirically verified
- [docs/source-maps.md](docs/source-maps.md) — inline maps, chaining to
  TypeScript, composing maps in Rust
- [docs/benchmarks.md](docs/benchmarks.md) — cold start and transform-latency
  methodology and charts
- [docs/history.md](docs/history.md) — the Node loader breakage trail that
  shaped the design, and the removed Frida fs-detour fallback
- [hooks/interplay-matrix](hooks/interplay-matrix) — the Node 22/24/26
  hook/`Module._load` interplay matrix (`pnpm matrix`)
- [Presentation.md](Presentation.md) / [RustPresentation.md](RustPresentation.md) —
  slide decks from the project's research phase
