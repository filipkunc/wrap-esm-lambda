// A stand-in for a coexisting agent, registering through both funnels real
// agents use:
// - directly against `@azure/functions-core` — what Application Insights'
//   AzureFunctionsHook does (the module is served by the worker's require
//   proxy, so CJS require is the only way in);
// - through the `@azure/functions` library's `app.hook.*` — the documented
//   route for app code.
// It burns measurable time in its hooks and in a callback wrapper, replaces
// nothing, and registers one post hook LATE (from inside its first pre hook
// run) — the case that would slip behind a bracket held only by registration
// order.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let core
try {
  core = require('@azure/functions-core')
} catch {
  core = undefined
}

if (core === undefined) {
  console.log('FAKEAPM:no-core')
} else {
  let latePostRegistered = false
  core.registerHook('preInvocation', async (context) => {
    console.log('FAKEAPM:pre')
    await sleep(5)
    const chain = context.functionCallback
    context.functionCallback = async (...args) => {
      console.log('FAKEAPM:wrap')
      await sleep(5) // wrapper cost, distinct from hook-body cost: the report separates them
      return chain(...args)
    }
    if (!latePostRegistered) {
      latePostRegistered = true
      core.registerHook('postInvocation', async () => {
        console.log('FAKEAPM:post-late')
        await sleep(5)
      })
    }
  })
  core.registerHook('postInvocation', async () => {
    console.log('FAKEAPM:post')
    await sleep(5)
  })
}

const { app } = await import('@azure/functions')
app.hook.postInvocation(() => {
  console.log('FAKEAPM:post-library')
})
