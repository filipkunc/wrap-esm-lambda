// Patches against the real frameworks, one per package shape.

// express (pure CJS): a named property of module.exports — the json
// body-parser factory. Wrapping it tags every middleware it creates.
export function patchExpressJson(bindings) {
  const orig = bindings.json
  bindings.json = function (...args) {
    const middleware = orig.apply(this, args)
    middleware.__wrapped = true
    return middleware
  }
}

// fastify (CJS whose module.exports IS the API function): the reserved
// "module.exports" binding rebinds the callable itself. Attached properties
// (fastify.errorCodes, .default, ...) must ride along — same duty any
// monkey-patch of a function-with-properties has.
export function patchFastifyFactory(bindings) {
  const orig = bindings['module.exports']
  const wrapped = function (...args) {
    const app = orig.apply(this, args)
    app.decorate('__wrapped', true)
    return app
  }
  Object.assign(wrapped, orig)
  // fastify self-references: module.exports.fastify === module.exports (and
  // .default too). ESM named imports snapshot those properties, so a rebind
  // of the callable must rebind its aliases with it.
  wrapped.fastify = wrapped
  wrapped.default = wrapped
  bindings['module.exports'] = wrapped
}

// hono (dual package), mutation flavor: prototype methods (route) are
// shared by both builds' consumers — a get-only accessor suffices, so this
// works on the ESM defining module AND the bundled CJS barrel whose exports
// are getter-only.
export function patchHonoRoute(bindings) {
  const { Hono } = bindings
  const orig = Hono.prototype.route
  Hono.prototype.route = function (...args) {
    globalThis.__hono_routes = (globalThis.__hono_routes ?? 0) + 1
    return orig.apply(this, args)
  }
}

// hono, rebind flavor: `request`/`fetch` are class FIELDS (per-instance
// arrows), invisible to prototype patching — intercepting them means
// rebinding the export to a subclass. The ESM build's local binding allows
// that; the bundled CJS build's getter-only exports cannot be rebound (the
// tap's setter throws rather than no-op), so this entry targets dist/hono.js
// only.
export function patchHonoRebind(bindings) {
  const Orig = bindings.Hono
  bindings.Hono = class extends Orig {
    constructor(...args) {
      super(...args)
      const origRequest = this.request
      this.request = (...requestArgs) => {
        globalThis.__hono_requests = (globalThis.__hono_requests ?? 0) + 1
        return origRequest(...requestArgs)
      }
    }
  }
}
