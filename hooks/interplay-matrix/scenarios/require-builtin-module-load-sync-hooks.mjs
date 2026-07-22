// The built-in crux: require('node:http') can only be intercepted at
// Module._load — built-ins have no source for a load hook to transform. Does
// that interception path survive sync hooks being registered? (This is what
// require-in-the-middle-based APMs need to stay alive.)
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
require('node:http')

console.log(seen.some((r) => r === 'node:http' || r === 'http') ? 'RESULT:SEEN' : 'RESULT:BYPASSED')
