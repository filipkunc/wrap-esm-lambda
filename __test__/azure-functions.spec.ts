import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import * as nodeModule from 'node:module'

// The azure-functions preset against a replica of the platform it targets.
// The replica below reproduces, line for line where it matters, what the
// worker does (Azure/azure-functions-nodejs-worker):
// - `setupCoreModule`: serve `@azure/functions-core` from a
//   `Module.prototype.require` proxy — the module never exists as a file;
// - `registerHook`/`executeHooks`: hooks in a plain array, pushed in
//   registration order, executed as a sequential awaited loop, disposal by
//   splice;
// - `InvocationHandler.handleEvent`: pre hooks may replace `inputs` and
//   `functionCallback` (both read back), post hooks may replace `result` and
//   `error` (both read back), all hook contexts of one invocation share one
//   `hookData` object.
// The CI Azure lane runs the same preset through the real host via Core
// Tools' `func start`; this spec answers the ordering and detection questions
// fast, on every lane, with the arrays in reach.

const hasRegisterHooks = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function'
const testRuntime = hasRegisterHooks ? test : test.skip

const preset = await import('@wrap-esm-lambda/hooks/azure-functions')
type Report = import('@wrap-esm-lambda/hooks/azure-functions').AzureInvocationReport
type Registration = import('@wrap-esm-lambda/hooks/azure-functions').HookRegistration

// --- the worker replica -----------------------------------------------------

class Disposable {
  #callback: () => void
  constructor(callback: () => void) {
    this.#callback = callback
  }
  dispose(): void {
    this.#callback()
  }
}

type HookCallback = (context: unknown) => unknown
const hookStore: Record<string, HookCallback[]> = {}
const getHooks = (name: string) => (hookStore[name] ??= [])

const coreApi = {
  version: '1.0.0-replica',
  registerHook(hookName: string, callback: HookCallback): Disposable {
    const hooks = getHooks(hookName)
    hooks.push(callback)
    return new Disposable(() => {
      const index = hooks.indexOf(callback)
      if (index > -1) hooks.splice(index, 1)
    })
  },
  Disposable,
}

async function executeHooks(hookName: string, context: unknown): Promise<void> {
  for (const callback of getHooks(hookName)) {
    await callback(context)
  }
}

function serveCoreModule(): void {
  Module.prototype.require = new Proxy(Module.prototype.require, {
    apply(target, thisArg, argArray: unknown[]) {
      if (argArray[0] === '@azure/functions-core') {
        return coreApi
      }
      return Reflect.apply(target, thisArg, argArray as [string])
    },
  })
}

const appHookData: Record<string | symbol, unknown> = {}
type FunctionCallback = (...args: unknown[]) => unknown

/** The InvocationHandler's exact sequence, minus the RPC envelope. */
async function invoke(callback: FunctionCallback, inputs: unknown[] = [], name = 'hello'): Promise<unknown> {
  const hookData: Record<string | symbol, unknown> = {}
  const invocationContext = { invocationId: `inv-${++invocationCounter}`, functionName: name }
  const preContext = {
    get hookData() {
      return hookData
    },
    get appHookData() {
      return appHookData
    },
    get invocationContext() {
      return invocationContext
    },
    functionCallback: callback,
    inputs,
  }
  await executeHooks('preInvocation', preContext)
  inputs = preContext.inputs
  const finalCallback = preContext.functionCallback
  const postContext = {
    get hookData() {
      return hookData
    },
    get appHookData() {
      return appHookData
    },
    get invocationContext() {
      return invocationContext
    },
    inputs,
    result: null as unknown,
    error: null as unknown,
  }
  try {
    postContext.result = await finalCallback(invocationContext, inputs)
  } catch (err) {
    postContext.error = err
  }
  await executeHooks('postInvocation', postContext)
  if (postContext.error != null) {
    throw postContext.error
  }
  return postContext.result
}

let invocationCounter = 0
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const requireAsWorkerServes = createRequire(import.meta.url)

// --- the run ----------------------------------------------------------------

const reports: Report[] = []
const registrations: Registration[] = []
const options = {
  force: true,
  onReport: (report: Report) => reports.push(report),
  onRegistration: (registration: Registration) => registrations.push(registration),
}

testRuntime('before the worker serves the core module, activation misses and stays retriable', () => {
  assert.strictEqual(preset.activateAzureFunctions(options), false)
  assert.strictEqual(preset.azureFunctionsActive(), false)
})

testRuntime('armed at preload, active at the first load event after the core module appears', async () => {
  preset.armAzureFunctions(options)
  assert.strictEqual(preset.azureFunctionsActive(), false, 'arming alone must not activate')
  serveCoreModule()
  // no user code has run yet at a module's load event — the import below
  // stands in for the first user module the worker loads
  await import('./fixtures/azure-functions/probe.mjs')
  assert.strictEqual(preset.azureFunctionsActive(), true)
  // the bracket: pre first + pre last, post last
  assert.strictEqual(getHooks('preInvocation').length, 2)
  assert.strictEqual(getHooks('postInvocation').length, 1)
})

testRuntime('activation is idempotent — a second copy adds no hooks', () => {
  assert.strictEqual(preset.activateAzureFunctions(options), true)
  assert.strictEqual(getHooks('preInvocation').length, 2)
  assert.strictEqual(getHooks('postInvocation').length, 1)
})

testRuntime('foreign hooks land inside the bracket and are timed and attributed', async () => {
  const core = requireAsWorkerServes('@azure/functions-core') as typeof coreApi
  assert.strictEqual(core.version, '1.0.0-replica', 'the replica proxy must serve the core module')

  let handlerAlreadyWrappedWhenForeignPreRan = false
  const handler = async () => {
    await sleep(5)
    return 'payload'
  }
  core.registerHook('preInvocation', (context) => {
    const preContext = context as { functionCallback: FunctionCallback }
    // ours-first, observable: by the time any foreign pre hook runs, the
    // callback is no longer the registered handler
    handlerAlreadyWrappedWhenForeignPreRan = preContext.functionCallback !== handler
    const chain = preContext.functionCallback
    preContext.functionCallback = async (...args: unknown[]) => {
      await sleep(10) // a foreign callback wrapper with measurable cost
      return chain(...args)
    }
  })
  core.registerHook('postInvocation', async () => {
    await sleep(10)
  })

  // re-append kept ours last on both sides
  assert.strictEqual(getHooks('preInvocation').length, 3)
  assert.strictEqual(getHooks('postInvocation').length, 2)

  assert.strictEqual(await invoke(handler), 'payload')
  assert.strictEqual(handlerAlreadyWrappedWhenForeignPreRan, true)

  const report = reports.at(-1)!
  // both foreign hooks appear in the report — the post one could only be
  // there if our closing hook ran after it
  assert.deepStrictEqual(
    report.hookTimings.map((timing) => [timing.hookName, timing.registrant]),
    [
      ['preInvocation', 'app'],
      ['postInvocation', 'app'],
    ],
  )
  assert.ok(report.hookTimings[1]!.ms >= 8, `foreign post hook timed: ${report.hookTimings[1]!.ms}ms`)
  // innermost vs outermost: the callback phase carries the foreign wrapper's
  // sleep, the handler measurement does not
  assert.ok(report.handlerMs! >= 4, `handler timed: ${report.handlerMs}ms`)
  assert.ok(report.callbackMs! >= report.handlerMs! + 8, `wrapper cost visible: ${report.callbackMs}ms`)
  assert.ok(report.totalMs >= report.callbackMs!, 'the bracket surrounds the callback phase')
  assert.strictEqual(report.callbackReplaced, true, 'the foreign wrapper is detected')
  assert.strictEqual(report.handlerBypassed, false)
  assert.strictEqual(report.resultAlteredByWrappers, false)
  assert.strictEqual(report.resultAlteredByPostHooks, false)
  assert.strictEqual(report.invocationId, `inv-${invocationCounter}`)
  assert.strictEqual(report.functionName, 'hello')

  // and the choke point attributed both registrations (this file is not
  // under node_modules, so they attribute to 'app')
  assert.deepStrictEqual(
    registrations.map((registration) => [registration.hookName, registration.registrant]),
    [
      ['preInvocation', 'app'],
      ['postInvocation', 'app'],
    ],
  )
  assert.deepStrictEqual(preset.azureHookRegistrations(), registrations)
})

testRuntime('a post hook registered later still executes before the closing hook', async () => {
  const core = requireAsWorkerServes('@azure/functions-core') as typeof coreApi
  const disposable = core.registerHook('postInvocation', async () => {
    await sleep(2)
  })
  assert.strictEqual(await invoke(async () => 'again'), 'again')
  const report = reports.at(-1)!
  assert.strictEqual(report.hookTimings.filter((timing) => timing.hookName === 'postInvocation').length, 2)

  // disposal reaches through the timing wrapper: the worker's splice removes it
  disposable.dispose()
  await invoke(async () => 'after-dispose')
  assert.strictEqual(reports.at(-1)!.hookTimings.filter((timing) => timing.hookName === 'postInvocation').length, 1)
})

testRuntime('a pre hook replacing the callback outright is reported as a bypassed handler', async () => {
  const core = requireAsWorkerServes('@azure/functions-core') as typeof coreApi
  const disposable = core.registerHook('preInvocation', (context) => {
    ;(context as { functionCallback: FunctionCallback }).functionCallback = async () => 'hijacked'
  })
  assert.strictEqual(await invoke(async () => 'never'), 'hijacked')
  const report = reports.at(-1)!
  assert.strictEqual(report.callbackReplaced, true)
  assert.strictEqual(report.handlerBypassed, true, 'the original handler never ran')
  assert.strictEqual(report.handlerMs, undefined)
  disposable.dispose()
})

testRuntime('input swaps and post-hook result mutation are detected', async () => {
  const core = requireAsWorkerServes('@azure/functions-core') as typeof coreApi
  const preDisposable = core.registerHook('preInvocation', (context) => {
    ;(context as { inputs: unknown[] }).inputs = ['replaced']
  })
  const postDisposable = core.registerHook('postInvocation', (context) => {
    ;(context as { result: unknown }).result = 'mutated'
  })
  const seen: unknown[] = []
  const result = await invoke(
    async (_context, inputs) => {
      seen.push(...(inputs as unknown[]))
      return 'original'
    },
    ['original-input'],
  )
  // the worker honors both mutations — and the report names them
  assert.strictEqual(result, 'mutated')
  assert.deepStrictEqual(seen, ['replaced'])
  const report = reports.at(-1)!
  assert.strictEqual(report.inputsReplaced, true)
  assert.strictEqual(report.resultAlteredByPostHooks, true)
  assert.strictEqual(report.resultAlteredByWrappers, false)
  preDisposable.dispose()
  postDisposable.dispose()
})

testRuntime('a post hook suppressing the error is detected — and honored, as on the platform', async () => {
  const core = requireAsWorkerServes('@azure/functions-core') as typeof coreApi
  const disposable = core.registerHook('postInvocation', (context) => {
    const postContext = context as { result: unknown; error: unknown }
    if (postContext.error != null) {
      postContext.error = null
      postContext.result = 'rescued'
    }
  })
  const result = await invoke(async () => {
    throw new Error('handler failure')
  })
  assert.strictEqual(result, 'rescued', 'the worker reads error/result back after post hooks')
  const report = reports.at(-1)!
  assert.strictEqual(report.errorAlteredByPostHooks, true)
  disposable.dispose()
})

testRuntime('a handler error nobody touches passes through, bracketed and reported', async () => {
  await assert.rejects(
    invoke(async () => {
      throw new Error('unhandled')
    }),
    /unhandled/,
  )
  const report = reports.at(-1)!
  assert.strictEqual(report.errorAlteredByPostHooks, false)
  assert.strictEqual(report.handlerMs !== undefined, true, 'a throwing handler is still timed')
  assert.strictEqual(report.resultAlteredByPostHooks, false)
})
