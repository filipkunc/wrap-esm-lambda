import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { transformLambdaWithMap } from '../../index.js'

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/handler-throws.mjs')) {
      const filename = basename(fileURLToPath(url))
      const transformed = transformLambdaWithMap(result.source.toString(), 'handler', 'WrapAwsLambda', filename)
      return { format: 'module', shortCircuit: true, source: transformed }
    }
    return result
  },
})
