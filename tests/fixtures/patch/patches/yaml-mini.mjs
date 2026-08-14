// Wraps `load` of yaml-mini (real js-yaml minified dist bytes assembled into
// a fixture package at test time) — the marker proves the patch ran through
// the CJS evaluation wrap on a real-world minified single-line bundle.
export function patchYamlMini(bindings) {
  const orig = bindings.load
  bindings.load = (input, opts) => ({ __viaPatch: true, value: orig(input, opts) })
}
