// Rebinds the const-declared handler — possible only because the tap's
// rewrite path demoted the declaration, which is exactly the path that
// regenerates the module and could lose its comments.
export function patchConstHandler(bindings) {
  const orig = bindings.handler
  bindings.handler = async (event) => `wrapped:${await orig(event)}`
}
