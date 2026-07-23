// The HOW: ordinary imperative monkey-patching against the live export.
// `application` is inherited into every app express() creates, so wrapping
// its `handle` observes every request; wrapping res.end inside it reads the
// matched route at the moment the final handler responds — req.baseUrl is
// the router mount prefix, req.route.path the route template, composing to
// OTel's http.route (`/api/users/:id`, never `/api/users/42`).
export function patchExpressRoute({ application }) {
  const origHandle = application.handle
  application.handle = function (req, res, ...rest) {
    const origEnd = res.end
    res.end = function (...args) {
      const route = `${req.baseUrl ?? ''}${req.route?.path ?? ''}`
      if (route) console.log(`http.route = ${route} (raw url ${req.originalUrl})`)
      return origEnd.apply(this, args)
    }
    return origHandle.call(this, req, res, ...rest)
  }
}
