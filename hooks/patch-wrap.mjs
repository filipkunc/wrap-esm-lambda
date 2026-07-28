export function wrapHandler(bindings) {
  const original = bindings.handler
  bindings.handler = async (event, context) => `wrapped:${await original(event, context)}`
}
