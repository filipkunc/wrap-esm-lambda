// Trivial off-thread loader for the mixed register()+registerHooks scenario:
// a pure passthrough, the least any APM-style module.register() user does.
export async function load(url, context, nextLoad) {
  return nextLoad(url, context)
}
