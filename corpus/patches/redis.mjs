// redis (node-redis): rebind the createClient factory on the transpiled
// CJS entry.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchRedis(bindings) {
  const orig = bindings.createClient
  bindings.createClient = function createClient(...args) {
    bump()
    return orig.apply(this, args)
  }
}
