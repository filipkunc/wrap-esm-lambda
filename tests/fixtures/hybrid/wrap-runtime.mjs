// The patch the config points at: rebinds the tapped `handler` export
// through an ordinary wrapper function.
export function wrapHandler(bindings) {
  const original = bindings.handler
  bindings.handler = async (event, context) => `wrapped:${await original(event, context)}`
}
