// A builtin patch: same imperative model as the package patches, but the
// accessors wrap a core module's live exports object (node:os), mutated at
// preload before any user code loads.
export function patchOs(bindings) {
  const orig = bindings.hostname
  bindings.hostname = function () {
    return `patched:${orig.call(this)}`
  }
}
