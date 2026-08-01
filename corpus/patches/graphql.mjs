// graphql: rebinding a function export at its DEFINING module
// (language/parser), so the patch propagates through the package's
// re-export chain to every import route via ESM live bindings.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchGraphql(bindings) {
  const orig = bindings.parse
  bindings.parse = function parse(...args) {
    bump()
    return orig.apply(this, args)
  }
}
