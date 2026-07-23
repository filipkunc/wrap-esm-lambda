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
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
    patch: { name: 'patchExpressRoute', from: fileURLToPath(new URL('./patches/http-route.mjs', import.meta.url)) },
    bindings: ['application'],
  },
])
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

await build({ entryPoints: ['app.mjs'], bundle: true, format: 'esm', plugins: [esbuildPlugin(config)] })
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
  `export const` is demoted to `let`, an anonymous `export default` is named
  into a local, re-exports and import-backed list exports are split into an
  import plus a rebindable local. Only modules that need it pay for it.

Either way the patch call runs at the end of the module's own evaluation:
after its definitions exist, before any importer sees them.

- `bindings.X` reads the live value; mutating it
  (`X.prototype.send = ...`) works everywhere.
- `bindings.X = wrapped` **rebinds** the export — an ESM live binding
  reassignment or a `module.exports.X` write. The reserved
  `'module.exports'` binding rebinds a CJS module whose export _is_ the API
  (fastify's factory); `'default'` taps a default export.
- ESM and CJS get mode-specific snippets; the CJS-or-ESM decision reproduces
  Node's own format rules, so a pure-CJS express or the two trees of a dual
  package like hono each parse correctly.
- Patch delivery differs per mode: at build time a static import of your
  patch module is appended and bundled; at runtime the register entry
  preloads patch functions into a global registry the tap reads (a
  hook-overridden CJS source cannot serve an injected `require`).

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

| package                                          | role                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@wrap-esm-lambda/core`](packages/core)         | config (`defineConfig`/`definePatches`), matcher, apply step; the [patch author contract](packages/core/README.md#patch-author-contract)   |
| [`@wrap-esm-lambda/hooks`](packages/hooks)       | **runtime** shell: synchronous `registerHooks` load hook + eager builtin patching, activated via `node --import`                           |
| [`@wrap-esm-lambda/unplugin`](packages/unplugin) | **build-time** shell: one [unplugin](https://unplugin.unjs.io/), adapters for Vite/Rolldown, Rollup, esbuild, webpack, Rspack              |
| [`wrap-esm-lambda`](index.d.ts) (repo root)      | the native oxc addon both shells call: `exportsTap*` (the tap) and `transformLambda*` (the handler wrap), with zero-copy `Buffer` variants |

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

- `patch.from` should be an **absolute path** (compute it via
  `import.meta.url`). TypeScript patch files ride on Node's type stripping at
  runtime and on the bundler at build time.
- **Builtin targets** (`node:http`, `os`, ...) have no source to transform:
  the runtime shell patches their exports object **eagerly at preload**,
  before any user code loads, so `require()`, ESM default import and ESM
  named import all observe the patch. Builtin entries are runtime-only and
  reject `files`.
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

## Worked examples

The test suite doubles as a recipe book — each spec runs the real package:

| target                             | what it shows                                                                                                                                                    | spec                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **AWS SDK** (`@smithy/core`)       | one entry intercepts every `@aws-sdk/client-*` operation via `Client#send` — runtime hook on the SDK's bundled `dist-cjs`, esbuild on its `dist-es`, same patch  | [`aws.spec.ts`](__test__/aws.spec.ts)               |
| **express** (pure CJS)             | tapping named `module.exports` properties; both `require('express')` and `import express` see the patch                                                          | [`frameworks.spec.ts`](__test__/frameworks.spec.ts) |
| **fastify** (CJS, callable export) | rebinding the whole export via the reserved `'module.exports'` binding — wrapping the factory itself                                                             | [`frameworks.spec.ts`](__test__/frameworks.spec.ts) |
| **hono** (dual package)            | one entry covering both dist trees; _target the defining module, not the barrel_; where rebinding meets bundled-CJS reality and fails loudly instead of silently | [`frameworks.spec.ts`](__test__/frameworks.spec.ts) |
| **`http.route` capture**           | the actual APM work: per-request route _templates_ for express/fastify/hono, mirroring each opentelemetry-js-contrib mechanism, delivered declaratively          | [`http-route.spec.ts`](__test__/http-route.spec.ts) |
| **builtins** (`node:os`)           | eager preload patching observed by require, default import and named import                                                                                      | [`patch.spec.ts`](__test__/patch.spec.ts)           |
| **rewrite shapes**                 | `export const` (the Lambda handler shape), anonymous `export default` and re-export barrels — all rebound via the rewrite path, runtime and build mode alike     | [`tap-shapes.spec.ts`](__test__/tap-shapes.spec.ts) |
| **hybrid**                         | runtime and build mode produce identical output; the sentinel prevents double-wrapping when both are on                                                          | [`hybrid.spec.ts`](__test__/hybrid.spec.ts)         |
| **mechanics & footguns**           | emission shapes, loud failures, version gating, patch dependency rules (including the one documented divergence between modes)                                   | [`patch.spec.ts`](__test__/patch.spec.ts)           |

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
3. `pnpm test` — Node binding tests with [`ava`](https://github.com/avajs/ava)
4. `cargo fmt` and `cargo clippy` before committing
5. `cargo test` — Rust tests

### WebAssembly

1. `rustup target add wasm32-wasip1-threads` to install the build target
2. `pnpm build --target wasm32-wasip1-threads` to create the `.wasm` file

### CI

CI tests against [`node@22`, `node@24`, `node@26`] x [`Linux`] matrix.

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
- Runtime-hook cold start overhead on a real fixture app is **~28 ms**, on
  par with import-in-the-middle's sync mode and ~3x cheaper than the
  off-thread loader OTel ships by default. Use a `.mjs` config (not `.ts`)
  where cold start matters.
- Module sources cross the napi boundary zero-copy as UTF-8 buffers on the
  runtime path; only the few-hundred-byte snippet comes back.

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
