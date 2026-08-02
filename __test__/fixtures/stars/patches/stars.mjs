export function patchShared(bindings) {
  const orig = bindings.shared
  bindings.shared = function shared(...args) {
    return `patched:${orig.apply(this, args)}`
  }
}
