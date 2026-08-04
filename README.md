# `wrap-esm-lambda`

![https://github.com/filipkunc/wrap-esm-lambda/actions](https://github.com/filipkunc/wrap-esm-lambda/workflows/CI/badge.svg)

**Declarative patching for Node.js modules — ESM, CJS, dual packages and core
builtins — delivered at runtime or at build time from one config.**

You describe _what_ to patch (package name, semver range, files, exported
bindings) and write an ordinary imperative patch function. The toolkit appends
a generic **exports tap** to the matched module's source, and your function
receives the module's live bindings as get/set accessors — the same reach
`Module._load` monkey-patching ever had, but working for `import` and
`require()` alike. The project began as an experiment in wrapping AWS Lambda
ESM handlers ([still a first-class use case](#wrapping-an-aws-lambda-handler))
and grew into a general instrumentation toolkit.

New here? Start with the **[getting-started tutorial](docs/getting-started.md)**
— it walks from an empty directory to a patched express app in both delivery
modes.

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

Both modes run the **same transform** and can be combined safely — a sentinel
comment guards against double-patching. A runnable copy of this exact setup
lives in [examples/express-route](examples/express-route):

```sh
pnpm --filter example-express-route start
```

## Which package do I need?

The toolkit is a small family of packages; you only install the ones for your
delivery mode. All of them share one config format
([reference](docs/config.md)).

| you want to…                                                     | use                                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| write a config and patch functions (always needed)               | [`@wrap-esm-lambda/core`](packages/core) — `definePatches`, the [patch author contract](packages/core/README.md#patch-author-contract) |
| patch at **runtime**, no build changes (`node --import`)         | [`@wrap-esm-lambda/hooks`](packages/hooks)                                                                                             |
| patch at **build time** (Vite, Rollup, esbuild, webpack, Rspack) | [`@wrap-esm-lambda/unplugin`](packages/unplugin)                                                                                       |
| wrap an AWS Lambda handler                                       | the [`aws-lambda` preset](packages/hooks/README.md#aws-lambda) in `@wrap-esm-lambda/hooks`                                             |
| bracket Azure Functions invocations                              | the [`azure-functions` preset](packages/hooks/README.md#azure-functions) in `@wrap-esm-lambda/hooks`                                   |
| run with **no native binary** (unsupported platform, WASM edge)  | [`@wrap-esm-lambda/engine-acorn`](packages/engine-acorn) — `WRAP_ESM_LAMBDA_ENGINE=acorn`, same output, pure JS                        |

Under both shells sits the native transform: the root
[`wrap-esm-lambda`](src/lib.rs) package, an [oxc](https://oxc.rs/) addon via
[napi.rs](https://napi.rs/). It is an implementation detail — the shells load
it for you and fall back to the pure-JS acorn engine when no prebuilt binary
exists for your platform.

Because a config is code and patch entries are plain data, instrumentation
also ships as an ordinary npm package (config + patches + register entry) that
an app activates with one flag — the pattern an APM vendor would use. See
[shipping instrumentation as a package](docs/config.md#shipping-instrumentation-as-a-package).

## How it works, in one minute

The matched module is parsed once (full AST) and every requested binding is
validated against its statically visible exports — a missing export is a hard
error, the version-drift alarm. Then a small snippet is **appended** to the
module's source: it calls your patch function at the end of the module's own
evaluation — after its definitions exist, before any importer sees them — with
get/set accessors over the live bindings. Reading `bindings.X` gives the live
value; assigning `bindings.X = wrapped` rebinds the export for every importer.

Export shapes that cannot be rebound as written (`export const`, anonymous
`export default`, re-export barrels, `export * from` chains) are restructured
through one AST rewrite with a source map; everything else leaves the source
byte-for-byte untouched. ESM and CJS each get a mode-specific snippet, chosen
by reproducing Node's own format rules.

The full mechanism — the fast/rewrite tiers, rebinding semantics, the
CJS-or-ESM decision, how the two delivery modes differ, and why the classic
alternatives (`Module._load` patching, loader proxies, body-rewriting
transforms) each have a blind spot this design avoids — is in
**[docs/how-it-works.md](docs/how-it-works.md)**.

## Wrapping an AWS Lambda handler

The problem this repo started with: turn

```js
export const handler = async (event) => 'Hi from AWS Lambda'
```

into

```js
export const handler = WrapAwsLambda(async (event) => 'Hi from AWS Lambda')
```

On Lambda the handler's file and export name are not yours to write down —
the platform owns them (`_HANDLER`, `LAMBDA_TASK_ROOT`). The `aws-lambda`
preset reads that contract at preload and emits an ordinary patch entry, so
the config names nothing:

```js
// wrap.config.mjs
import { definePatches } from '@wrap-esm-lambda/core'
import { lambdaHandlerEntries } from '@wrap-esm-lambda/hooks/aws-lambda'

export default definePatches(
  [...lambdaHandlerEntries({ patch: { name: 'wrapHandler', from: './patches/lambda.mjs' } })],
  import.meta.url,
)
```

```js
// patches/lambda.mjs — the platform picked the export's name, so don't name it
export function wrapHandler(bindings) {
  for (const name of Object.keys(bindings)) {
    bindings[name] = WrapAwsLambda(bindings[name])
  }
}
```

Activation goes through `NODE_OPTIONS=--import`; outside Lambda the same
config is inert. CI verifies the whole arrangement on AWS's real
`public.ecr.aws/lambda/nodejs` images, answering real invocations. The
practical composition — a [Hono](https://hono.dev/) app on Lambda with its
handler timed, routes labeled and the AWS SDK intercepted — is
[examples/hono-lambda](examples/hono-lambda); platform analysis is in
[docs/serverless.md](docs/serverless.md).

**Azure Functions** needs no handler transform at all: the platform ships a
`preInvocation`/`postInvocation` hook pipeline, and the `azure-functions`
preset brackets it — first and last hook, per-invocation timing, foreign
hooks attributed to their registering package. See the
[preset docs](packages/hooks/README.md#azure-functions),
[examples/azure-functions](examples/azure-functions), and
[docs/serverless.md](docs/serverless.md#azure-functions-the-hook-pipeline-first-and-last).

## When instrumentation fails

Instrumentation sits in the load path of a process it does not own, so the
rule is: **fail soft wherever partial degradation exists, stay loud where
there is nothing to degrade to.** A drifted binding, a throwing patch or a
missing native addon each cost exactly one entry, one patch call or one
engine — the app still starts; only an unresolvable config fails startup, on
purpose. Every recovered failure reports once on stderr and is retrievable
via `instrumentationFailures()`, and `npx wrap-esm-lambda-validate` turns
version drift into a CI failure ahead of time.

| variable                    | effect                                                          |
| --------------------------- | --------------------------------------------------------------- |
| `WRAP_ESM_LAMBDA_DISABLE=1` | kill switch — no hooks, no patches, no transform                |
| `WRAP_ESM_LAMBDA_STRICT=1`  | every recovered failure throws instead (what CI runs)           |
| `WRAP_ESM_LAMBDA_DEBUG=1`   | trace decisions — engine, instrumented modules, skipped entries |

The full failure table, the validator, and engine selection are in
**[docs/failure-policy.md](docs/failure-policy.md)**.

## Performance

Headline numbers (methodology in [docs/benchmarks.md](docs/benchmarks.md)):

- The exports tap costs **~14 µs** per matched ESM module and **~2.4 µs** per
  CJS tap; orchestrion's body-rewriting transform on the same file costs
  ~950–1200 µs.
- Runtime-hook cold start overhead on a real fixture app is **~29 ms** — on
  par with import-in-the-middle's sync mode, ~3x cheaper than the off-thread
  loader OTel ships by default.
- The pure-JS acorn engine runs the same setup with no native binary: same
  emitted code, ~6x slower on the parse-dominated tap, ~14 ms more cold start.

## Building and running locally

Prerequisites: Node >= 22, [pnpm](https://pnpm.io/), and a
[Rust toolchain](https://rustup.rs/) (for the native addon).

```sh
git clone https://github.com/filipkunc/wrap-esm-lambda
cd wrap-esm-lambda
pnpm install         # dependencies
pnpm build           # native addon — required once after cloning (writes index.js/index.d.ts)
pnpm build:packages  # compile the workspace packages (pnpm test also runs this)
pnpm test            # the whole suite, on node --test
```

Then run any example, e.g. `pnpm --filter example-express-route start`.
Rust-side checks are `cargo fmt`, `cargo clippy` and `cargo test`. Details —
why the first build is mandatory, generated files, the TypeScript 7 setup,
the CI matrix and the release process — are in
**[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Documentation

Guides:

- [docs/getting-started.md](docs/getting-started.md) — tutorial: from empty
  directory to a patched app, runtime and build-time
- [docs/config.md](docs/config.md) — config reference, and shipping
  instrumentation as an npm package
- [docs/how-it-works.md](docs/how-it-works.md) — the exports tap mechanism,
  and comparisons with `Module._load` patching and loader proxies
- [docs/failure-policy.md](docs/failure-policy.md) — failure modes, the
  validator CLI, engine selection
- [CONTRIBUTING.md](CONTRIBUTING.md) — development, CI, releasing

Deep dives:

- [docs/real-packages.md](docs/real-packages.md) — worked examples and field
  notes from patching express, fastify, hono, the AWS SDK and builtins
- [docs/serverless.md](docs/serverless.md) — AWS Lambda / Azure Functions
  soundness, empirically verified
- [docs/comparisons.md](docs/comparisons.md) — reach and cost vs
  orchestrion-js and import-in-the-middle, with tests over identical targets
- [docs/benchmarks.md](docs/benchmarks.md) — cold start and transform-latency
  methodology and charts
- [docs/source-maps.md](docs/source-maps.md) — inline maps, chaining to
  TypeScript, composing maps in Rust
- [docs/history.md](docs/history.md) — the Node loader breakage trail that
  shaped the design
- [hooks/interplay-matrix](hooks/interplay-matrix) — the Node 22/24/26
  hook/`Module._load` interplay matrix (`pnpm matrix`)
- [Presentation.md](Presentation.md) / [RustPresentation.md](RustPresentation.md) —
  slide decks from the project's research phase
