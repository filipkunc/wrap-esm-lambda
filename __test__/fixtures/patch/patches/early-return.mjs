// Rebinds `greet` of @fake/early-return — the assertion is not the wrap
// itself but that the patch RAN AT ALL: the module's top-level `return`
// would have skipped an appended tap entirely.
export function patchEarlyReturn(bindings) {
  const orig = bindings.greet
  bindings.greet = (name) => `wrapped:${orig(name)}`
}
