// The generic patch: rebind every requested function binding to a wrapper
// that logs entry and exit, and captures exceptions — logging them and
// rethrowing, never swallowing. Plain named exports, no top-level side
// effects, no dependency on the toolkit — exactly the patch author contract.

function preview(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (value !== null && typeof value === 'object') return `[${value.constructor?.name ?? 'object'}]`
  return String(value)
}

function wrap(name, original) {
  const wrapped = function (...args) {
    console.log(`[fn-log] -> ${name}(${args.map(preview).join(', ')})`)
    try {
      const result = original.apply(this, args)
      if (result !== null && typeof result?.then === 'function') {
        return result.then(
          (value) => {
            console.log(`[fn-log] <- ${name} resolved ${preview(value)}`)
            return value
          },
          (err) => {
            console.log(`[fn-log] !! ${name} rejected ${err.name}: ${err.message}`)
            throw err
          },
        )
      }
      console.log(`[fn-log] <- ${name} returned ${preview(result)}`)
      return result
    } catch (err) {
      console.log(`[fn-log] !! ${name} threw ${err.name}: ${err.message}`)
      throw err
    }
  }
  Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true })
  return wrapped
}

/** Rebind every requested binding that is a function; leave the rest alone. */
export function logCalls(bindings) {
  for (const name of Object.keys(bindings)) {
    const original = bindings[name]
    if (typeof original === 'function') {
      bindings[name] = wrap(name, original)
    }
  }
}
