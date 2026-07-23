// The actual work an APM patch does for web frameworks: capture the matched
// route TEMPLATE (`/users/:id`, not `/users/42`) per request — OTel's
// `http.route` semantic attribute. Each patch mirrors the mechanism the
// corresponding opentelemetry-js-contrib instrumentation uses, delivered
// through the exports tap instead of require-in-the-middle.
const ROUTES = Symbol.for('wrap-esm-lambda.http-routes')
const store = () => (globalThis[ROUTES] ??= {})

// express: like instrumentation-express, observe the request at the app
// boundary. Wrapping `application.handle` (inherited into every created app)
// lets us wrap res.end, which runs inside the final handler — at that moment
// req.baseUrl holds the router mount prefix and req.route the matched Route,
// composing to the full template.
export function patchExpressRoute(bindings) {
  const application = bindings.application
  const origHandle = application.handle
  application.handle = function (req, res, ...rest) {
    const origEnd = res.end
    res.end = function (...endArgs) {
      const route = `${req.baseUrl ?? ''}${req.route?.path ?? ''}`
      if (route) store().express = route
      return origEnd.apply(this, endArgs)
    }
    return origHandle.call(this, req, res, ...rest)
  }
}

// fastify: like instrumentation-fastify, wrap the factory and add an
// onRequest hook — routing has already resolved by then, so
// request.routeOptions.url is the registered template.
export function patchFastifyRoute(bindings) {
  const orig = bindings['module.exports']
  const wrapped = function (...args) {
    const app = orig.apply(this, args)
    app.addHook('onRequest', (request, reply, done) => {
      store().fastify = request.routeOptions?.url
      done()
    })
    return app
  }
  Object.assign(wrapped, orig)
  wrapped.fastify = wrapped
  wrapped.default = wrapped
  bindings['module.exports'] = wrapped
}

// hono: like @hono/otel, a middleware reads the matched route path after
// dispatch. Auto-installing it needs the constructor, so the export is
// rebound to a subclass — possible on the ESM build's local binding (the
// bundled CJS getters cannot be rebound; see the frameworks entry docs).
export function patchHonoHttpRoute(bindings) {
  const Orig = bindings.Hono
  bindings.Hono = class extends Orig {
    constructor(...args) {
      super(...args)
      this.use(async (c, next) => {
        await next()
        const matched = c.req.routePath ?? c.req.matchedRoutes?.filter((r) => r.method !== 'ALL').at(-1)?.path
        if (matched) store().hono = matched
      })
    }
  }
}
