# Tutorial: runtime instrumentation, from zero

Patch [hono](https://hono.dev) — a modern **dual package** (native ESM
`dist/`, bundled CJS `dist/cjs/`) — so every request logs one line, **without
touching app code and without a build step**. This directory is
self-contained: it installs `wrap-esm-lambda` from
[pkg.pr.new](https://pkg.pr.new) previews the way any project outside this
repo would (see [../README.md](../README.md) for how those URLs work).

## 1. Install and run

```sh
npm install
npm start
```

Expected output:

```
[wrap-esm-lambda] GET /hello/world
response = { hello: 'world' }
```

The first line comes from the patch; the app never wrote it.

## 2. What just happened — the three files

**[`app.mjs`](app.mjs)** is an ordinary hono app. Hono is fetch-based, so
there is no server to stand up — `app.request()` dispatches a request
in-process. The file contains no instrumentation code and never will:

```js
import { Hono } from 'hono'

const app = new Hono()
app.get('/hello/:name', (c) => c.json({ hello: c.req.param('name') }))

const response = await app.request('/hello/world')
console.log('response =', await response.json())
```

**[`patches/log-requests.mjs`](patches/log-requests.mjs)** is the imperative
half. It receives the exports it asked for as live get/set accessors, and
**rebinds** `Hono` to a subclass that installs one logging middleware in its
constructor:

```js
export function logRequests(bindings) {
  const OrigHono = bindings.Hono
  bindings.Hono = class extends OrigHono {
    constructor(...args) {
      super(...args)
      this.use(async (c, next) => {
        console.log(`[wrap-esm-lambda] ${c.req.method} ${c.req.path}`)
        await next()
      })
    }
  }
}
```

Assigning `bindings.Hono` swaps what every importer sees — rebinding an ESM
export, the thing `Module._load` monkey-patching never could. Subclassing
(rather than patching the prototype) is the real-world shape here: hono
defines `fetch`/`request` as per-instance class fields, invisible to
prototype patches, and [@hono/otel](https://github.com/honojs/middleware)
instruments the same way.

**[`wrap.config.mjs`](wrap.config.mjs)** is the declarative half: which
package (`hono`), which versions (`>=4 <5` — outside the range the entry is
skipped), which file, which exports (`Hono`), and which patch function to
call. The file is `dist/hono.js` — where the class is _defined_ — not the
`dist/index.js` barrel that merely re-exports it: targeting the defining
module keeps the transform on its append-only fast path and lands for
consumers that bypass the barrel.

## 3. The activation line

The whole runtime integration is the `start` script:

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
```

`@wrap-esm-lambda/hooks/register` installs a `module.registerHooks` load hook
(hence Node >= 22.15) that appends an exports tap to `dist/hono.js` as it is
loaded and calls `logRequests` with accessors over the requested bindings.
Remove the flag and the app runs unpatched; nothing else changes.

A dual-package note: this app `import`s hono, which resolves to the ESM tree,
where the rebind works on the local binding. A `require()`d hono resolves to
the bundled-CJS tree whose getter-only exports cannot be rebound — there the
tap fails **loudly** at patch time (and the app keeps running) instead of
silently missing instrumentation. See
[docs/real-packages.md](../../../docs/real-packages.md) for that story.

## 4. When it doesn't work

Failures are soft by default — a broken entry is dropped and the app still
starts. To see why:

```sh
WRAP_ESM_LAMBDA_DEBUG=1 npm start    # trace matches, skips and rewrites
WRAP_ESM_LAMBDA_STRICT=1 npm start   # recovered failures throw instead
npx wrap-esm-lambda-validate ./wrap.config.mjs   # config vs installed tree, for CI
```

If `npm install` 404s, no preview exists for that ref yet — previews are
published by CI on green pushes to `main` ([details](../README.md)).

## 5. Where to go next

The build-time twin of this project is [`../unplugin`](../unplugin) — same
app, same config, same patch; only the delivery changes. The full tutorial
with more depth is [docs/getting-started.md](../../../docs/getting-started.md).
