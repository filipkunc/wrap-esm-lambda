# `@wrap-esm-lambda/hooks`

The runtime half of the hybrid setup: wraps matched modules **at load time**
with Node's synchronous `module.registerHooks`, using the same native oxc
transform as the build-time plugin. No build pipeline changes; the cold start
cost is microseconds per matched module (see the repo's
[cold-start benchmarks](../../docs/benchmarks.md)).

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

Requires Node.js >= 22.15 — synchronous `module.registerHooks` does not exist
on earlier versions. On older runtimes use the build-time shell
([`@wrap-esm-lambda/unplugin`](../unplugin)), which has no runtime floor. On a
runtime that lacks it the missing hook is reported rather than thrown: eager
builtin patches still apply and the app still starts.

## Failure policy

This shell instruments modules the app merely depends on, so its failures are
contained by default: a patch module that will not import drops its own entry,
a module whose transform throws loads untouched, a patch function that throws
is caught, and a builtin whose binding moved is skipped. Each reports once on
stderr and lands in core's `instrumentationFailures()`.

- `WRAP_ESM_LAMBDA_DISABLE=1` — off entirely: no config resolution, no engine
  load, no hooks. The lever for an incident, no redeploy needed.
- `WRAP_ESM_LAMBDA_STRICT=1` — turn every recovered failure back into a throw.
- `WRAP_ESM_LAMBDA_DEBUG=1` — trace matches, skips and rewrites to stderr.

Config resolution itself stays loud: there is nothing to degrade to, and
silently running uninstrumented is the one failure an operator cannot see. The
full table is in the [root README](../../README.md#failure-policy-what-happens-when-instrumentation-cannot-do-its-job).
