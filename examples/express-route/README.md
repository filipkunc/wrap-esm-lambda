# example: express `http.route` capture

The README quick start as a runnable project: patch express 5 so every request
logs its matched route _template_ (`/api/users/:id`, never `/api/users/42` —
OTel's `http.route` attribute), with zero changes to the app.

Three files, mirroring the split you'd use in a real service:

- [`app.mjs`](app.mjs) — an ordinary express app; knows nothing about patching
- [`wrap.config.mjs`](wrap.config.mjs) — _what_ to patch: package, version
  range, file, bindings
- [`patches/http-route.mjs`](patches/http-route.mjs) — _how_: plain imperative
  code against the live `application` export

Run it from the repo root (after `pnpm install` and `pnpm build`):

```sh
pnpm --filter example-express-route start
```

Expected output:

```
http.route = /api/users/:id (raw url /api/users/42)
response = { id: '42' }
```

The activation line in `package.json` is the whole runtime integration:

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
```

The same config file drives build-time delivery instead — see
[`@wrap-esm-lambda/unplugin`](../../packages/unplugin) — and
[`__test__/http-route.spec.ts`](../../__test__/http-route.spec.ts) extends
this exact pattern to fastify and hono.
