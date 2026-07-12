import { registerHooks } from 'node:module'
import { create } from '@apm-js-collab/code-transformer'

const matcher = create([
  {
    channelName: 'lambda-handler',
    module: { name: 'runtime', versionRange: '>=0.0.0', filePath: 'handler.mjs' },
    functionQuery: { expressionName: 'handler', kind: 'Async' },
  },
])

const transformer = matcher.getTransformer('runtime', '1.0.0', 'handler.mjs')

let patched = false
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!patched && url.endsWith('/handler.mjs')) {
      patched = true
      const transformed = transformer.transform(result.source.toString(), 'esm')
      // console.log("Transformed source:\n", transformed.code);
      return {
        format: 'module',
        shortCircuit: true,
        source: transformed.code,
      }
    }
    return result
  },
})
