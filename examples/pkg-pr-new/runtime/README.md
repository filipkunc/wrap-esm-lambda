# Tutorial: runtime instrumentation, from zero

Patch express so every request logs one line — **without touching app code
and without a build step**. This directory is self-contained: it installs
`wrap-esm-lambda` from [pkg.pr.new](https://pkg.pr.new) previews the way any
project outside this repo would (see [../README.md](../README.md) for how
those URLs work).

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

**[`app.mjs`](app.mjs)** is an ordinary express app. It imports express,
serves `/hello/:name`, fires one request at itself and exits. It contains no
instrumentation code and never will.

**[`patches/log-requests.mjs`](patches/log-requests.mjs)** is the imperative
half: a plain function handed express's live `application` export, wrapping
its `handle` method — the kind of monkey-patch you'd write in any wrapper,
just living in its own file:

```js
export function logRequests({ application }) {
  const origHandle = application.handle
  application.handle = function (req, res, ...rest) {
    console.log(`[wrap-esm-lambda] ${req.method} ${req.url}`)
    return origHandle.call(this, req, res, ...rest)
  }
}
```

**[`wrap.config.mjs`](wrap.config.mjs)** is the declarative half: which
package (`express`), which versions (`>=5 <6` — outside the range the entry
is skipped), which file (`lib/express.js`, the module that _defines_ the
binding), which exports (`application`), and which patch function to call.

## 3. The activation line

The whole runtime integration is the `start` script:

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
```

`@wrap-esm-lambda/hooks/register` installs a `module.registerHooks` load hook
(hence Node >= 22.15) that appends an exports tap to `lib/express.js` as it
is loaded — for `import` and `require()` alike — and calls `logRequests`
with live get/set accessors over the requested bindings. Remove the flag and
the app runs unpatched; nothing else changes.

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
