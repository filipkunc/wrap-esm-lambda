import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'
import remapping from '@jridgewell/remapping'
import { transformLambdaWithMapObject } from '../../index.js'

// Reads the `//# sourceMappingURL=` from a transpiled file and returns the raw
// map JSON, whether it is an inline data URL or a sibling `.map` file.
function readUpstreamMap(url, source) {
  const match = source.match(/\/\/# sourceMappingURL=(\S+)/)
  if (!match) return undefined
  const ref = match[1]
  if (ref.startsWith('data:')) {
    const base64 = ref.slice(ref.indexOf(',') + 1)
    return Buffer.from(base64, 'base64').toString('utf8')
  }
  return readFileSync(resolve(dirname(fileURLToPath(url)), ref), 'utf8')
}

function inlineMap(code, mapJson) {
  const stripped = code.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '')
  const base64 = Buffer.from(mapJson, 'utf8').toString('base64')
  return `${stripped}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/handler.js')) {
      const jsSource = result.source.toString()
      const jsName = basename(fileURLToPath(url))
      const { code, map } = transformLambdaWithMapObject(jsSource, 'handler', 'WrapAwsLambda', jsName)

      // map: transformed -> handler.js. Compose with tsc's handler.js -> handler.ts
      // map so the final map reaches the original TypeScript.
      const upstream = readUpstreamMap(url, jsSource)
      const finalMap =
        map && upstream ? remapping(map, (file) => (file.endsWith(jsName) ? upstream : null)).toString() : map

      const source = finalMap ? inlineMap(code, finalMap) : code
      return { format: 'module', shortCircuit: true, source }
    }
    return result
  },
})
