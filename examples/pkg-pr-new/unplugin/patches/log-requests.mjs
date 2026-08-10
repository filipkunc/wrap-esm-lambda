// The imperative half: rebind hono's `Hono` class to a subclass that
// auto-installs one logging middleware. Assigning `bindings.Hono` swaps the
// export for every importer. Subclassing (rather than patching the
// prototype) is the real-world shape here — hono defines `fetch`/`request`
// as per-instance class fields, invisible to prototype patches; @hono/otel
// instruments the same way.
export function logRequests(bindings) {
  const OrigHono = bindings.Hono
  bindings.Hono = class extends OrigHono {
    constructor(...args) {
      super(...args)
      this.use(async (c, next) => {
        console.log(`[wrap-esm-lambda] ${c.req.method} ${c.req.path}`)
        await next()
      })
    }
  }
}
