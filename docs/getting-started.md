# Getting started

A step-by-step walk from an empty directory to a patched express app, in both
delivery modes. Nothing here requires cloning this repo — only published
packages. (To run the repo's own examples instead, see
[building and running locally](../README.md#building-and-running-locally).)

**What we'll build**: express, patched so every request logs its matched
route _template_ (`/api/users/:id`, never `/api/users/42` — OTel's
`http.route` attribute), with zero changes to app code.

## 1. Set up a project

```sh
mkdir hello-wrap && cd hello-wrap
npm init -y
npm install express @wrap-esm-lambda/core @wrap-esm-lambda/hooks
```

Requirements: Node >= 22.15 for the runtime mode (`module.registerHooks`);
build-time mode has no runtime floor.

An ordinary app, no instrumentation awareness:

```js
// app.mjs
import express from 'express'

const app = express()
app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }))

app.listen(3000, () => console.log('listening on :3000'))
```

## 2. Write a patch function

A patch is plain imperative code. It receives the module's exports you asked
for (as live get/set accessors) and does whatever it wants to them —
wrapping methods is the bread-and-butter case:

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

Keep patch modules free of top-level side effects, and never import the
package you're patching at the patch module's top level — the full rules are
in the [patch author contract](../packages/core/README.md#patch-author-contract).

## 3. Declare where it applies

The config is the declarative half: which package, which versions, which
file, which exports.

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
  import.meta.url, // makes './patches/…' resolve relative to this file
)
```

Every field is documented in the [config reference](config.md). Two tips that
matter early:

- **Target the defining module, not the barrel** (`files`): patching the file
  that declares the binding avoids restructuring and lands no matter which
  path imports it.
- The `versionRange` is a guard, not decoration — when the installed version
  drifts out of range the entry is skipped, and requesting a binding that no
  longer exists is a hard error rather than silence.

## 4. Run it — runtime mode

One flag, no build changes:

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
```

```sh
curl localhost:3000/api/users/42
# server log:
#   http.route = /api/users/:id
```

If nothing happens, ask the toolkit why:

```sh
WRAP_ESM_LAMBDA_DEBUG=1 …    # trace matches, skips and rewrites to stderr
WRAP_ESM_LAMBDA_STRICT=1 …   # turn silently-recovered failures into throws
```

(Failures are soft by default — a broken patch drops that one entry and the
app still starts. The [failure policy](failure-policy.md) explains the whole
table.)

## 5. Run it — build-time mode

The same config file drives a bundler plugin instead
([unplugin](https://unplugin.unjs.io/): Vite/Rolldown, Rollup, esbuild,
webpack, Rspack). The deployed artifact is pre-instrumented, so cold start
pays nothing:

```sh
npm install esbuild @wrap-esm-lambda/unplugin
```

```js
// build.mjs
import { build } from 'esbuild'
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.mjs'

await build({
  entryPoints: ['app.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'dist/app.mjs',
  // express's CJS graph requires node builtins; esbuild's ESM output needs
  // the standard createRequire shim for those (unrelated to the plugin)
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [esbuildPlugin(config)],
})
```

```sh
node build.mjs && node dist/app.mjs
```

Both modes emit byte-identical instrumentation, and a sentinel comment keeps
the hybrid combination single-patched — enabling both at once is safe.

## 6. Guard against drift in CI

`wrap-esm-lambda-validate` checks a config against the installed tree —
package present, version in range, files there, exports still exported, patch
module importable — and exits non-zero on any failure:

```sh
npx wrap-esm-lambda-validate ./wrap.config.mjs
```

Run it in CI so a dependency bump that renames a binding fails your build
instead of silently dropping telemetry later.

## Where to go next

- [Config reference](config.md) — all entry fields, builtin targets
  (`node:http`), path-matched targets, and
  [shipping instrumentation as an npm package](config.md#shipping-instrumentation-as-a-package)
- [Patch author contract](../packages/core/README.md#patch-author-contract) —
  exactly what your patch function may rely on
- [Worked examples](real-packages.md) — fastify, hono, the AWS SDK, builtins;
  each backed by a spec that runs the real package
- [AWS Lambda](../packages/hooks/README.md#aws-lambda) and
  [Azure Functions](../packages/hooks/README.md#azure-functions) presets —
  handler wrapping and invocation bracketing with zero handler-specific config
- [How it works](how-it-works.md) — what the transform actually does to a
  module
