import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, basename } from 'node:path'
import { transformLambdaWithChainedMap } from '../../index.js'

// Same chain as sync-hooks-oxc-ts.mjs, but composed in Rust by oxc_sourcemap
// instead of @jridgewell/remapping: one call wraps the handler, traces its map
// through tsc's map, and returns code with the .ts-reaching map already inlined.

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

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/handler.js')) {
      const jsSource = result.source.toString()
      const upstream = readUpstreamMap(url, jsSource)
      if (!upstream) return result
      // Drop tsc's sourceMappingURL comment: that map is superseded by the
      // chained one the transform inlines.
      const stripped = jsSource.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '')
      const jsName = basename(fileURLToPath(url))
      const source = transformLambdaWithChainedMap(stripped, 'handler', 'WrapAwsLambda', jsName, upstream)
      return { format: 'module', shortCircuit: true, source }
    }
    return result
  },
})
