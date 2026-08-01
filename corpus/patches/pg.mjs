// pg: prototype mutation on the exported Client class — the bread-and-butter
// path. `query` is what every OTel pg instrumentation wraps.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchPg({ Client }) {
  const orig = Client.prototype.query
  Client.prototype.query = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
