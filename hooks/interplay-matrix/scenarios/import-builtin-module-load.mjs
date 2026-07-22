// Control for the built-in crux: `import` of a built-in has NEVER flowed
// through Module._load — the ESM linker binds core modules directly. A
// BYPASSED here is by design on every version, and is exactly why lazy
// Module._load patching alone never covered ESM consumers of node:http.
import Module from 'node:module'

const seen = []
const orig = Module._load
Module._load = function (request, ...rest) {
  seen.push(request)
  return orig.call(this, request, ...rest)
}

await import('node:http')

console.log(seen.some((r) => r === 'node:http' || r === 'http') ? 'RESULT:SEEN' : 'RESULT:BYPASSED')
