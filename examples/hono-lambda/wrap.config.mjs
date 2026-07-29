// One config, three layers of the same Lambda function: the handler itself
// (discovered from _HANDLER at preload — nothing about it is written down
// here), the framework serving it, and the AWS SDK underneath it. Outside
// Lambda the preset entry is inert and the other two still apply.
import { definePatches } from '@wrap-esm-lambda/core'
import { lambdaHandlerEntries } from '@wrap-esm-lambda/hooks/aws-lambda'

export default definePatches(
  [
    ...lambdaHandlerEntries({
      patch: { name: 'recordInvocationMetrics', from: './patches/invocation-metrics.mjs' },
    }),
    {
      // ESM build only: the subclass rebind needs a rebindable local
      // binding, which the bundled CJS barrel's getter-only exports are not
      // (the tap throws rather than silently no-op there)
      module: { name: 'hono', versionRange: '>=4 <5', files: ['dist/hono.js'] },
      patch: { name: 'patchHonoRoute', from: './patches/http-route.mjs' },
      bindings: ['Hono'],
    },
    {
      module: {
        name: '@smithy/core',
        versionRange: '>=3 <5',
        files: ['dist-es/submodules/client/smithy-client/client.js', 'dist-cjs/submodules/client/index.js'],
      },
      patch: { name: 'patchSmithyClient', from: './patches/aws-sdk.mjs' },
      bindings: ['Client'],
    },
  ],
  import.meta.url,
)
