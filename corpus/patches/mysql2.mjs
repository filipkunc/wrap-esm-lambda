// mysql2: rebind a named factory export on handwritten CJS.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchMysql2(bindings) {
  const orig = bindings.createPool
  bindings.createPool = function createPool(...args) {
    bump()
    return orig.apply(this, args)
  }
}
