# Tutorial: build-time instrumentation, from zero

Patch [hono](https://hono.dev) — a modern **dual package** (native ESM
`dist/`, bundled CJS `dist/cjs/`) — so every request logs one line, **baked
into the bundle at build time, with zero runtime cost**. This directory is
self-contained: it installs `wrap-esm-lambda` from
[pkg.pr.new](https://pkg.pr.new) previews the way any project outside this
repo would (see [../README.md](../README.md) for how those URLs work).

It is the build-time twin of [`../runtime`](../runtime): the app, the config
and the patch function are byte-for-byte identical. Only the delivery
changes — `@wrap-esm-lambda/unplugin` in place of `@wrap-esm-lambda/hooks`,
and a bundler invocation in place of a `node --import` flag.

## 1. Install and run

```sh
npm install
npm start        # = node build.mjs && node dist/app.mjs
```

Expected output:

```
[wrap-esm-lambda] GET /hello/world
response = { hello: 'world' }
```

The first line comes from the patch; the app never wrote it.

## 2. What just happened — the four files

**[`app.mjs`](app.mjs)**, **[`wrap.config.mjs`](wrap.config.mjs)** and
**[`patches/log-requests.mjs`](patches/log-requests.mjs)** are unchanged from
the runtime tutorial — the app knows nothing, the config says _what_ to patch
(hono `>=4 <5`, `dist/hono.js`, the `Hono` export), the patch says _how_
(rebind `Hono` to a subclass that installs one logging middleware). Read the
[runtime tutorial](../runtime/README.md#2-what-just-happened--the-three-files)
for the walk-through of each.

**[`build.mjs`](build.mjs)** is the only new file. It runs esbuild with one
plugin, fed the same config:

```js
import { build } from 'esbuild'
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.mjs'

await build({
  entryPoints: ['app.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'dist/app.mjs',
  plugins: [esbuildPlugin(config)],
})
```

The plugin intercepts `dist/hono.js` in the bundler's transform stage —
before bundling, so the config's file matching works unchanged — and appends
the same exports tap the runtime hook would. Bundling `import`s hono, so
esbuild resolves the ESM tree of the dual package, where rebinding the
export works on the local binding. esbuild is just this tutorial's pick:
`@wrap-esm-lambda/unplugin` exports the same plugin for Vite/Rolldown,
Rollup, webpack and Rspack.

## 3. The payoff: nothing ships

`dist/app.mjs` is pre-instrumented. Run it with plain `node`, no flags:

```sh
node dist/app.mjs
```

Every package this project installs is a `devDependency` on purpose — the
toolkit, esbuild, even hono exist only at build time, and cold start pays
nothing for instrumentation. Grep the bundle for `logRequests` to see the
patch and the tap sitting inline.

Both modes emit byte-identical instrumentation, and a sentinel comment keeps
a module single-patched — enabling this build **and** the runtime hook at
once is safe.

## 4. When it doesn't work

```sh
WRAP_ESM_LAMBDA_DEBUG=1 npm run build    # trace matches, skips and rewrites
WRAP_ESM_LAMBDA_ENGINE=oxc npm run build # fail the build if the native addon is broken,
                                         # instead of degrading to the pure-JS engine
```

If `npm install` 404s, no preview exists for that ref yet — previews are
published by CI on green pushes to `main` ([details](../README.md)).

## 5. Where to go next

The runtime twin is [`../runtime`](../runtime). The full tutorial with more
depth is [docs/getting-started.md](../../../docs/getting-started.md), and the
plugin's engine selection and bundler adapters are documented in
[packages/unplugin](../../../packages/unplugin).
