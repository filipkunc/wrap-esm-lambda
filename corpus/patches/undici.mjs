// undici: rebinding a plain function export on handwritten CJS — the tap's
// verified setter guarantees the write took (no sloppy-mode silent no-op).
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchUndici(bindings) {
  const orig = bindings.request
  bindings.request = function request(...args) {
    bump()
    return orig.apply(this, args)
  }
}
