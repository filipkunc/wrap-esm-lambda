// The app's entry (package.json "main"). Two delivery shapes share it:
//
// - **prelude** (EXAMPLE_DELIVERY=prelude): activate right here, first line
//   of user code. The worker is fully set up before it loads this file, so
//   the core module is already being served — no load hooks, no worker
//   arguments, and Azure's prewarmed workers stay usable. This is the shape
//   Azure's own docs steer agents toward.
// - **preload** (default expectation when EXAMPLE_DELIVERY is unset): the
//   runtime shell arrived via `languageWorkers__node__arguments = --import
//   @wrap-esm-lambda/hooks/register`, evaluated wrap.config.mjs at preload,
//   and the preset armed itself — activation already happened at this very
//   file's load event, before this line ran.
//
// Either way, by the time the fake agent below registers anything, the
// bracket is watching the choke point.
if (process.env.EXAMPLE_DELIVERY === 'prelude') {
  const { activateAzureFunctions } = await import('@wrap-esm-lambda/hooks/azure-functions')
  const { reportOptions } = await import('./report.mjs')
  const activated = activateAzureFunctions(reportOptions)
  console.log(`WRAPESM:prelude-activated ${activated}`)
}

await import('./fake-apm.mjs')
await import('./functions/hello.mjs')
