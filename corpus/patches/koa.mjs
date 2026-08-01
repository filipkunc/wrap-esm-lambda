// koa: module.exports IS the Application class — the reserved
// "module.exports" binding hands over the whole slot; prototype mutation
// needs no rebinding.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchKoa(bindings) {
  const Application = bindings['module.exports']
  const orig = Application.prototype.use
  Application.prototype.use = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
