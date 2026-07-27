// A patch that never names the handler: the platform chose the export's name
// (_HANDLER), the preset put it in the entry's bindings, and the tap's
// accessors are enumerable — so wrapping "whatever was tapped" is a loop.
export function wrapHandler(bindings) {
  for (const name of Object.keys(bindings)) {
    const original = bindings[name]
    bindings[name] = async (...args) => `wrapped:${await original(...args)}`
  }
}
