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
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
      patch: { name: 'patchExpressRoute', from: './patches/http-route.mjs' },
      bindings: ['application'],
    },
  ],
  import.meta.url,
)
```

## AWS Lambda

On Lambda the function's own handler is a target whose file and export name
only the platform knows — it hands them to its runtime interface client as
`_HANDLER` and `LAMBDA_TASK_ROOT`. The `aws-lambda` preset reads the same
contract at preload (a config is code, evaluated before the RIC's late
handler import) and emits an ordinary path-matched patch entry, reproducing
the RIC's own resolution rules:

```js
// wrap.config.mjs — nothing about the handler is written down
import { definePatches } from '@wrap-esm-lambda/core'
import { lambdaHandlerEntries } from '@wrap-esm-lambda/hooks/aws-lambda'

export default definePatches(
  [...lambdaHandlerEntries({ patch: { name: 'wrapHandler', from: './patches/lambda.mjs' } })],
  import.meta.url,
)
```

Outside Lambda the same config is inert (no `_HANDLER`, no entry), so one
package can ship both this and its package-identity entries. Activation on
the platform goes through `NODE_OPTIONS=--import` — see
[docs/serverless.md](../../docs/serverless.md); the CI Lambda lane verifies
the whole arrangement on the real `public.ecr.aws/lambda/nodejs` images
through AWS's real runtime interface client.

## Azure Functions

On Azure the v4 model's own `preInvocation`/`postInvocation` pipeline is the
target, and its registry — `@azure/functions-core` — is a module the worker
serves from a `require()` proxy, never a file, so no file transform can reach
it. The `azure-functions` preset instead registers its hooks at the earliest
instant the platform allows and patches `registerHook` in place on the shared
core object: every later registration (any `@azure/functions` copy's
`app.hook.*`, Application Insights' direct core usage) is observed, timed per
invocation, attributed to its registering package, and the preset's closing
hooks are re-appended behind it — the bracket stays first and last, and each
invocation's report separates handler time from foreign wrapper and hook
time:

```js
import { azureFunctionsEntries } from '@wrap-esm-lambda/hooks/azure-functions'

export default definePatches([...azureFunctionsEntries({ onReport, onRegistration })], import.meta.url)
```

Outside an Azure worker (no `FUNCTIONS_WORKER_RUNTIME`) the config is inert.
For the `package.json` `"main"` prelude delivery, skip the config and call
`activateAzureFunctions(options)` directly — the worker is already set up
before any user module loads, so it activates immediately with no load hooks
at all. `armAzureFunctions(options)` is the preload half: it retries
activation at each module load event until the worker serves the core module,
which is still before the first line of user code runs. See
[examples/azure-functions](../../examples/azure-functions) for both shapes
under Core Tools' `func start`.

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
