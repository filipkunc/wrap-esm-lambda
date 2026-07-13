import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transformLambdaWithMap } from '../../index.js'

// No tsc, no @ampproject/remapping: oxc parses handler.ts directly, strips the
// types itself, and emits a map straight from the wrapped code to handler.ts.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/handler.ts')) {
      const tsSource = readFileSync(fileURLToPath(url), 'utf8')
      const source = transformLambdaWithMap(tsSource, 'handler', 'WrapAwsLambda', 'handler.ts')
      return { format: 'module', shortCircuit: true, source }
    }
    return nextLoad(url, context)
  },
})
