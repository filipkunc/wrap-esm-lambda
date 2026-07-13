# `@wrap-esm-lambda/hooks`

The runtime half of the hybrid setup: wraps matched modules **at load time**
with Node's synchronous `module.registerHooks`, using the same native oxc
transform as the build-time plugin. No build pipeline changes; the cold start
cost is microseconds per matched module (see the repo's cold-start table).

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs \
  node --import @wrap-esm-lambda/hooks/register app.mjs
```

```js
// wrap.config.mjs
import { defineConfig } from '@wrap-esm-lambda/core'

export default defineConfig({
  entries: [
    {
      match: 'handler.mjs',
      handler: 'handler',
      wrapper: { name: 'WrapAwsLambda', from: '/opt/nodejs/wrap-runtime.mjs' },
    },
  ],
})
```

Sources already instrumented at build time (sentinel present) are passed
through untouched, so layering this on an instrumented bundle is safe.
