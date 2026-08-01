// Shared between both delivery shapes: the prelude (src/main.mjs) and the
// preloaded config (wrap.config.mjs) hand the same callbacks to the preset,
// so the output is identical either way. The `WRAPESM:` prefix is what
// run-check.mjs (and the CI lane) greps and parses.
export const reportOptions = {
  onRegistration: (registration) => {
    console.log(`WRAPESM:registration ${JSON.stringify(registration)}`)
  },
  onReport: (report) => {
    console.log(`WRAPESM:report ${JSON.stringify(report)}`)
  },
}
