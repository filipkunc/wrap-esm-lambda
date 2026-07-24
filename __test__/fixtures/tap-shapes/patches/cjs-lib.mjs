// Rebinds the CJS export through the tap's `module.exports.<name>` accessor —
// delivered by a require() snippet in build mode, the registry at runtime.
export function patchCjsGreet(bindings) {
  const orig = bindings.greet
  bindings.greet = (name) => `wrapped:${orig(name)}`
}
