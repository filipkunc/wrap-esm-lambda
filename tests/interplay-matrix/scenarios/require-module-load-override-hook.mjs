// The overriding-hook variant on plain require(): the sync load hook
// replaces the CJS source (what wrap-esm-lambda's tap does) — does the
// Module._load monkey-patch still see the require, or does a source-carrying
// hook divert compilation around it?
import Module, { createRequire, registerHooks } from 'node:module'

if (typeof registerHooks !== 'function') {
  console.log('RESULT:NO_REGISTERHOOKS')
  process.exit(0)
}

const seen = []
const orig = Module._load
Module._load = function (request, ...rest) {
  seen.push(request)
  return orig.call(this, request, ...rest)
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.includes('/fixtures/dep.cjs')) {
      const out = { shortCircuit: true, source: Buffer.concat([Buffer.from(result.source), Buffer.from('\n;\n')]) }
      if (result.format != null) out.format = result.format
      return out
    }
    return result
  },
})

const require = createRequire(import.meta.url)
require('../fixtures/dep.cjs')

console.log(seen.some((r) => r.includes('dep.cjs')) ? 'RESULT:SEEN' : 'RESULT:BYPASSED')
