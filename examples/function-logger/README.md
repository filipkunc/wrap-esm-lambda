# example-function-logger

Instrumentation **as one npm package**: before/after logging of function
calls, with exception capture (logged, then rethrown). Everything an APM
vendor would ship — the patch code, the declarative config, and a register
entry — lives in this package; the app installs it and adds one flag.

```
src/
  patches/log-calls.mjs   the patch: wraps function bindings with entry/exit
                          logs; exceptions and rejections are logged and
                          rethrown, never swallowed
  config.mjs              definePatches([...], import.meta.url) — `from` is
                          relative to the config, so the package is
                          self-contained wherever it is installed
  register.mjs            the app-facing entry: registerConfig(config)
```

The app side ([example-function-logger-app](../function-logger-app)) is the
whole integration story:

```sh
node --import example-function-logger/register app.mjs
```

or, keeping the generic register entry and pointing it at this package's
config (`WRAP_ESM_LAMBDA_CONFIG` accepts package specifiers):

```sh
WRAP_ESM_LAMBDA_CONFIG=example-function-logger/config node --import @wrap-esm-lambda/hooks/register app.mjs
```

Run either from the repo root:

```sh
pnpm --filter example-function-logger-app start
pnpm --filter example-function-logger-app start:env-config
```

Expected output — note `fetchQuote` internally calls `getQuote`, and the
rebound live binding intercepts even that intra-module call (something
`Module._load` wrapping never could), and the app's own `catch` still runs
after the logger rethrows:

```
[fn-log] -> getQuote(1)
[fn-log] <- getQuote returned "ship it"
[fn-log] -> shout("ship it")
[fn-log] <- shout returned "SHIP IT!"
SHIP IT!
[fn-log] -> fetchQuote(2)
[fn-log] -> getQuote(2)
[fn-log] <- getQuote returned "make it work, make it right, make it fast"
[fn-log] <- fetchQuote resolved "make it work, make it right, make it fast"
make it work, make it right, make it fast
[fn-log] -> explode("demo")
[fn-log] !! explode threw Error: quote machine broke: demo
app caught: quote machine broke: demo
```

The same package serves build-time delivery unchanged — hand its config to
the unplugin adapter and the instrumentation is baked into the bundle:

```js
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
const { default: config } = await import('example-function-logger/config')
await build({
  entryPoints: ['app.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [esbuildPlugin(config)],
})
```

Both modes are exercised end-to-end by
[`__test__/packaging.spec.ts`](../../__test__/packaging.spec.ts).
