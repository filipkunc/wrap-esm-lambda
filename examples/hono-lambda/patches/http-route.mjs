// hono's per-request entry points (fetch, request) are class FIELDS —
// per-instance arrows, invisible to prototype patching — so the export is
// rebound to a subclass whose constructor injects a first middleware. Once
// next() has run the router, c.req.routePath is the matched route TEMPLATE
// (`/quotes/:id`) — OTel's http.route, the label a per-URL log line can
// never aggregate into.
export function patchHonoRoute(bindings) {
  const Orig = bindings.Hono
  bindings.Hono = class extends Orig {
    constructor(...args) {
      super(...args)
      this.use(async (c, next) => {
        await next()
        console.log(`http.route = ${c.req.method} ${c.req.routePath} -> ${c.res.status}`)
      })
    }
  }
}
