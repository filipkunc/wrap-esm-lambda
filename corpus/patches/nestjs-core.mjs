// The patch-through probe: Nest is not the target — express UNDERNEATH Nest
// is. The patch is the http-route example's shape (wrap application.handle),
// and the probe asserts a request served through Nest's abstraction still
// crosses it.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchExpress({ application }) {
  const orig = application.handle
  application.handle = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
