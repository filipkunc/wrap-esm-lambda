import { registerHooks } from 'node:module'
import { transformLambda } from '../../index.js'

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/handler-throws.mjs')) {
      const transformed = transformLambda(result.source.toString(), 'handler', 'WrapAwsLambda')
      return { format: 'module', shortCircuit: true, source: transformed }
    }
    return result
  },
})
