// Baseline: with no hooks registered, does a Module._load monkey-patch see a
// require()? This is the contract every classic CJS APM relies on.
import Module, { createRequire } from 'node:module'

const seen = []
const orig = Module._load
Module._load = function (request, ...rest) {
  seen.push(request)
  return orig.call(this, request, ...rest)
}

const require = createRequire(import.meta.url)
require('../fixtures/dep.cjs')

console.log(seen.some((r) => r.includes('dep.cjs')) ? 'RESULT:SEEN' : 'RESULT:BYPASSED')
