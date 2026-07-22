// dygabo's load_module_test observation: once sync customization hooks are
// registered (even pure passthroughs), does require() still flow through the
// Module._load monkey-patch — or is the patcher blinded?
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
    return nextLoad(url, context)
  },
})

const require = createRequire(import.meta.url)
require('../fixtures/dep.cjs')

console.log(seen.some((r) => r.includes('dep.cjs')) ? 'RESULT:SEEN' : 'RESULT:BYPASSED')
