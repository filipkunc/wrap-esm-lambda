// dygabo's blinding shape on the ESM->CJS path: register a sync load hook
// (pure passthrough), then `import` a CJS module — does the Module._load
// monkey-patch still see it, or does the hook's presence reroute CJS off the
// patchable path entirely?
import Module, { registerHooks } from 'node:module'

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

await import('../fixtures/dep.cjs')

console.log(seen.some((r) => r.includes('dep.cjs')) ? 'RESULT:SEEN' : 'RESULT:BYPASSED')
