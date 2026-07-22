// Baseline for the ESM->CJS path: with no hooks at all, does `import` of a
// CJS module flow through the Module._load monkey-patch? (Since the loader
// refactors this is the path the real AWS SDK takes under `import`.)
import Module from 'node:module'

const seen = []
const orig = Module._load
Module._load = function (request, ...rest) {
  seen.push(request)
  return orig.call(this, request, ...rest)
}

await import('../fixtures/dep.cjs')

console.log(seen.some((r) => r.includes('dep.cjs')) ? 'RESULT:SEEN' : 'RESULT:BYPASSED')
