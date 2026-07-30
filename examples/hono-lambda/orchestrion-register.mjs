// The comparison mechanism for the cold-start table: orchestrion-js
// (@apm-js-collab/code-transformer) instrumenting the same @smithy/core
// Client#send the smithy entry taps — registered the same way the runtime
// shell is (node --import), transforming the module as it loads. Mirrors
// hooks/sync-hooks-orchestrion.mjs and the orchestrion-compare spec: the
// mechanism's load-time cost is what the measurement wants, so no
// diagnostics_channel subscriber is attached (the hooks bench table makes
// the same choice and prices subscribers separately).
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { create } = require('@apm-js-collab/code-transformer')
const smithyVersion = require('@smithy/core/package.json').version

const matcher = create([
  {
    channelName: 'smithy-send',
    module: { name: '@smithy/core', versionRange: '>=0', filePath: 'client.js' },
    functionQuery: { className: 'Client', methodName: 'send', kind: 'Async' },
  },
])

const TARGETS = [
  { suffix: '/dist-es/submodules/client/smithy-client/client.js', type: 'esm' },
  { suffix: '/dist-cjs/submodules/client/index.js', type: 'cjs' },
]

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.includes('@smithy/core')) return result
    const target = TARGETS.find(({ suffix }) => url.endsWith(suffix))
    if (!target) return result
    const transformer = matcher.getTransformer('@smithy/core', smithyVersion, 'client.js')
    const transformed = transformer.transform(result.source.toString(), target.type)
    return { ...result, shortCircuit: true, source: transformed.code }
  },
})
