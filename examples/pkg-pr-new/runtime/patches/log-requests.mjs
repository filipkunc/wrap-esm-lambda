// The imperative half: plain code against express's live `application`
// export. Wraps the method every request funnels through and logs one line.
export function logRequests({ application }) {
  const origHandle = application.handle
  application.handle = function (req, res, ...rest) {
    console.log(`[wrap-esm-lambda] ${req.method} ${req.url}`)
    return origHandle.call(this, req, res, ...rest)
  }
}
