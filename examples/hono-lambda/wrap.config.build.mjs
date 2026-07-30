// The build-time flavor of wrap.config.mjs: same package entries, same
// patches — but the handler entries are written down explicitly, because at
// build time there is no Lambda environment to discover them from. The
// runtime config's preset spread is inert here for the same reason (no
// _HANDLER on a build machine), so composing the two double-patches nothing.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'
import { lambdaHandlerEntries } from '@wrap-esm-lambda/hooks/aws-lambda'
import runtimeConfig from './wrap.config.mjs'

const taskRoot = fileURLToPath(new URL('.', import.meta.url))
const metrics = { name: 'recordInvocationMetrics', from: './patches/invocation-metrics.mjs' }

export default definePatches(
  [
    ...lambdaHandlerEntries({ patch: metrics, handler: 'app.handler', taskRoot }),
    ...lambdaHandlerEntries({ patch: metrics, handler: 'consumer.handler', taskRoot }),
    ...runtimeConfig.entries,
  ],
  import.meta.url,
)
