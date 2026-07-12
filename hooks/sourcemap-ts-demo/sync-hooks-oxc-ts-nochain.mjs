import { registerHooks } from 'node:module'
import { transformLambdaWithMap } from '../../index.js'

// Wraps the handler with a source map that only reaches handler.js (NOT chained
// back to handler.ts). Shows the regression the chaining hook fixes.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/handler.js')) {
      const transformed = transformLambdaWithMap(result.source.toString(), 'handler', 'WrapAwsLambda', 'handler.js')
      return { format: 'module', shortCircuit: true, source: transformed }
    }
    return result
  },
})
