// Azure Functions preset: bracket every invocation from the platform's own
// hook pipeline — and see every other agent's hook registration on the way.
//
// Azure's Node worker executes `preInvocation`/`postInvocation` hooks strictly
// in registration order (worker `executeHooks`: a sequential awaited loop over
// a plain array), a pre hook may replace `inputs` and `functionCallback`, and
// a post hook may replace `result` and `error` — the worker reads all four
// back after the hooks run. There is no priority API: position in the array is
// the entire ordering contract. So "instrumented first and last" means:
//
// - **first**: register before anyone else. Nobody can register earlier than
//   worker setup — the hook registry lives in `@azure/functions-core`, a
//   module the worker serves from a `Module.prototype.require` proxy, so it
//   does not exist during `--require`/`--import` preload (and `@azure/functions`
//   permanently caches the miss: a copy of the library loaded at preload
//   registers nothing, forever, with only a console.warn). The earliest
//   possible slot is therefore "after worker setup, before the first user
//   module evaluates" — exactly what a load-hook poll delivers, since a load
//   event fires before its module's body runs.
// - **last**: impossible by registration time alone — anyone can register
//   after you. But `registerHook` is a writable property on the one shared
//   object the require proxy hands out, and every path funnels through it:
//   `app.hook.*` of every `@azure/functions` copy (via `tryGetCoreApiLazy`)
//   and direct `require('@azure/functions-core')` consumers (Application
//   Insights' AzureFunctionsHook) alike. Patching that one property in place
//   shows us every registration, so ours can be re-appended to the tail each
//   time — and each foreign callback can be individually timed and attributed
//   on the way through.
//
// That property patch is a deliberate, documented exception to this repo's
// file-transform approach: `@azure/functions-core` never exists as a file, so
// the exports tap fundamentally cannot reach it. Like the aws-lambda preset
// reading `_HANDLER`, this reads the platform's own extension contract — it
// never touches the module loader.
//
// What one invocation's bracket yields (see `AzureInvocationReport`): total
// time from our first pre hook to our last post hook; the callback phase from
// the outermost wrapper (applied by our *last* pre hook, so it surrounds every
// foreign callback wrapper); the pure handler from the innermost wrapper
// (applied by our *first* pre hook, so nothing sits between it and the user's
// code); per-hook timings for every foreign pre/post hook; and whether anyone
// replaced the inputs, the callback, the result, or the error along the way.
import * as nodeModule from 'node:module'
import { createRequire } from 'node:module'
import type { PatchEntry } from '@wrap-esm-lambda/core'
import { debug, isDisabled, recover } from '@wrap-esm-lambda/core/diagnostics'

/** The shapes this preset relies on from the worker-served core module. */
interface CoreDisposable {
  dispose(): void
}
type HookData = Record<string | symbol, unknown>
interface CoreHookContext {
  readonly hookData: HookData
  readonly appHookData: HookData
}
type FunctionCallback = (...args: unknown[]) => unknown
interface CorePreInvocationContext extends CoreHookContext {
  readonly invocationContext: unknown
  inputs: unknown[]
  functionCallback: FunctionCallback
}
interface CorePostInvocationContext extends CoreHookContext {
  readonly invocationContext: unknown
  inputs: unknown[]
  result: unknown
  error: unknown
}
interface CoreApi {
  registerHook(hookName: string, callback: (context: never) => unknown): CoreDisposable
}

/** One hook registration observed at the `registerHook` choke point. */
export interface HookRegistration {
  /** 'preInvocation' | 'postInvocation' | 'appStart' | 'appTerminate' | 'log' | ... */
  hookName: string
  /** the registering package (from `node_modules/<pkg>` in the stack), or 'app' */
  registrant: string
  /** the stack frame the attribution came from, for when the package is not enough */
  frame: string
}

/** One foreign pre/post hook's wall time inside a single invocation. */
export interface HookTiming {
  hookName: string
  registrant: string
  ms: number
}

/** What the bracket saw for one invocation. */
export interface AzureInvocationReport {
  invocationId: string | undefined
  functionName: string | undefined
  /** our first pre hook → our last post hook: the whole pipeline */
  totalMs: number
  /** everything between our first and last pre hook: the foreign pre-hook chain */
  preHooksMs: number
  /** the callback phase, outermost — includes every foreign callback wrapper */
  callbackMs: number | undefined
  /** the user's handler alone, innermost — excludes everything foreign */
  handlerMs: number | undefined
  /** per-hook wall time of every foreign pre/post hook that ran */
  hookTimings: HookTiming[]
  /** a foreign pre hook swapped the inputs array */
  inputsReplaced: boolean
  /** a foreign pre hook wrapped or replaced the function callback */
  callbackReplaced: boolean
  /** the callback phase ran but the original handler never did — replaced, not wrapped */
  handlerBypassed: boolean
  /** a foreign callback wrapper returned something else than the handler did */
  resultAlteredByWrappers: boolean
  /** a foreign post hook left a different result than the callback phase returned */
  resultAlteredByPostHooks: boolean
  /** a foreign post hook suppressed, replaced, or injected the error */
  errorAlteredByPostHooks: boolean
}

export interface AzureFunctionsOptions {
  /** receives each invocation's report; default logs one line under WRAP_ESM_LAMBDA_DEBUG */
  onReport?: (report: AzureInvocationReport) => void
  /** receives each observed hook registration; default logs under WRAP_ESM_LAMBDA_DEBUG */
  onRegistration?: (registration: HookRegistration) => void
  /** arm even when FUNCTIONS_WORKER_RUNTIME is absent (tests, replicas) */
  force?: boolean
}

/** Per-invocation state, kept on the worker's own shared per-invocation hookData. */
interface InvocationState {
  t0: number
  tPreLast?: number
  inputsAtFirst: unknown[]
  callbackAtFirst?: FunctionCallback
  chainWrapped?: boolean
  inputsReplaced?: boolean
  callbackReplaced?: boolean
  handlerRan?: boolean
  handlerStart?: number
  handlerEnd?: number
  handlerResult?: unknown
  chainRan?: boolean
  chainStart?: number
  chainEnd?: number
  chainResult?: unknown
  chainThrew?: boolean
  chainError?: unknown
  reported?: boolean
}

interface PresetState {
  active: boolean
  options: AzureFunctionsOptions
  registrations: HookRegistration[]
  register: CoreApi['registerHook']
  preLastDisposable: CoreDisposable
  postLastDisposable: CoreDisposable
}

// Global slots, keyed with Symbol.for: a second copy of this preset (one in
// the app, one arriving through preload) must observe the first activation
// instead of double-bracketing every invocation.
const STATE_SLOT = Symbol.for('wrap-esm-lambda.azure-functions.state')
const INVOCATION_STATE = Symbol.for('wrap-esm-lambda.azure-functions.invocation')
const TIMINGS = Symbol.for('wrap-esm-lambda.azure-functions.timings')
const globalSlots = globalThis as unknown as Record<symbol, unknown>

const requireCore = createRequire(import.meta.url)

const now = (): number => Number(process.hrtime.bigint()) / 1e6

const isThenable = (value: unknown): value is Promise<unknown> =>
  value !== null && typeof value === 'object' && typeof (value as Promise<unknown>).then === 'function'

/**
 * The worker serves `@azure/functions-core` from a require proxy the moment
 * `setupCoreModule` has run; before that the specifier resolves nowhere. A
 * miss here is retriable — unlike `@azure/functions`' own `tryGetCoreApiLazy`,
 * which caches the null forever.
 */
function tryRequireCore(): CoreApi | undefined {
  try {
    const core = requireCore('@azure/functions-core') as CoreApi
    return typeof core?.registerHook === 'function' ? core : undefined
  } catch {
    return undefined
  }
}

/**
 * Who called `registerHook`: the nearest stack frame that is neither this
 * preset nor the `@azure/functions` library (whose `app.hook.*` funnels every
 * library-path registration through one bundled dist frame), attributed to
 * its `node_modules` package — or 'app' for code outside any package.
 */
function attributeRegistrant(stack: string | undefined): { registrant: string; frame: string } {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const frame = line.trim()
    if (!frame.startsWith('at ')) continue
    if (frame.includes('node:internal')) continue
    if (/azure-functions\.m[tj]s/.test(frame)) continue // this preset (src and dist alike)
    if (/[\\/]dist[\\/]azure-functions\.js/.test(frame)) continue // the library's bundled dist
    const packages = frame.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/@][^\\/]*)/g)
    const last = packages?.[packages.length - 1]
    const registrant = last ? last.replace(/^node_modules[\\/]/, '').replace(/\\/g, '/') : 'app'
    return { registrant, frame }
  }
  return { registrant: 'unknown', frame: '' }
}

function notifyRegistration(state: PresetState, registration: HookRegistration): void {
  state.registrations.push(registration)
  if (state.options.onRegistration) {
    try {
      state.options.onRegistration(registration)
    } catch (err) {
      recover('azure-functions preset: onRegistration callback', err)
    }
  } else {
    debug(`azure-functions preset: observed ${registration.hookName} hook from ${registration.registrant}`)
  }
}

/** Record a foreign hook's wall time on the invocation's shared hookData. */
function recordTiming(context: CoreHookContext, timing: HookTiming): void {
  const bag = context?.hookData as HookData | undefined
  if (bag === undefined) return
  ;((bag[TIMINGS] ??= []) as HookTiming[]).push(timing)
}

/** Time a foreign pre/post hook callback without changing what it observes or throws. */
function timeForeignHook(
  hookName: string,
  registrant: string,
  callback: (context: never) => unknown,
): (context: CoreHookContext) => unknown {
  return function timedHook(context: CoreHookContext): unknown {
    const start = now()
    const finish = () => recordTiming(context, { hookName, registrant, ms: now() - start })
    try {
      const out = callback(context as never)
      if (isThenable(out)) {
        return out.then(
          (value) => {
            finish()
            return value
          },
          (err) => {
            finish()
            throw err
          },
        )
      }
      finish()
      return out
    } catch (err) {
      finish()
      throw err
    }
  }
}

/** How a wrapped callback ended: a value returned, or an error thrown. */
type CallbackOutcome = { threw: false; value: unknown } | { threw: true; error: unknown }

/** Wrap a function callback, timing it and capturing its outcome into `state`. */
function wrapCallback(
  callback: FunctionCallback,
  state: InvocationState,
  markStart: (state: InvocationState, at: number) => void,
  markEnd: (state: InvocationState, at: number, outcome: CallbackOutcome) => void,
): FunctionCallback {
  return function wrappedCallback(this: unknown, ...args: unknown[]): unknown {
    markStart(state, now())
    try {
      const out = callback.apply(this, args)
      if (isThenable(out)) {
        return out.then(
          (value) => {
            markEnd(state, now(), { threw: false, value })
            return value
          },
          (err: unknown) => {
            markEnd(state, now(), { threw: true, error: err })
            throw err
          },
        )
      }
      markEnd(state, now(), { threw: false, value: out })
      return out
    } catch (err) {
      markEnd(state, now(), { threw: true, error: err })
      throw err
    }
  }
}

/** Runs first among pre hooks: opens the bracket, wraps the handler innermost. */
function preFirstHook(context: CorePreInvocationContext): void {
  const state: InvocationState = {
    t0: now(),
    inputsAtFirst: context.inputs,
  }
  context.hookData[INVOCATION_STATE] = state
  const original = context.functionCallback
  if (typeof original === 'function') {
    const inner = wrapCallback(
      original,
      state,
      (s, at) => {
        s.handlerStart = at
      },
      (s, at, outcome) => {
        s.handlerEnd = at
        s.handlerRan = true
        if (!outcome.threw) s.handlerResult = outcome.value
      },
    )
    context.functionCallback = inner
    state.callbackAtFirst = inner
  }
}

/** Runs last among pre hooks: detects swaps, wraps the callback chain outermost. */
function preLastHook(context: CorePreInvocationContext): void {
  const state = context.hookData[INVOCATION_STATE] as InvocationState | undefined
  if (state === undefined || state.chainWrapped) return
  state.chainWrapped = true
  state.tPreLast = now()
  state.inputsReplaced = context.inputs !== state.inputsAtFirst
  state.callbackReplaced = context.functionCallback !== state.callbackAtFirst
  const chain = context.functionCallback
  if (typeof chain === 'function') {
    context.functionCallback = wrapCallback(
      chain,
      state,
      (s, at) => {
        s.chainStart = at
      },
      (s, at, outcome) => {
        s.chainEnd = at
        s.chainRan = true
        s.chainThrew = outcome.threw
        if (outcome.threw) s.chainError = outcome.error
        else s.chainResult = outcome.value
      },
    )
  }
}

/** Runs last among post hooks: closes the bracket and emits the report. */
function postLastHook(this: void, context: CorePostInvocationContext, state: PresetState): void {
  const invocation = context.hookData?.[INVOCATION_STATE] as InvocationState | undefined
  if (invocation === undefined || invocation.reported) return
  invocation.reported = true
  const t1 = now()
  const invocationContext = context.invocationContext as { invocationId?: string; functionName?: string } | undefined
  const chainOutcomeKnown = invocation.chainRan === true
  const report: AzureInvocationReport = {
    invocationId: invocationContext?.invocationId,
    functionName: invocationContext?.functionName,
    totalMs: t1 - invocation.t0,
    preHooksMs: (invocation.tPreLast ?? invocation.t0) - invocation.t0,
    callbackMs:
      invocation.chainStart !== undefined && invocation.chainEnd !== undefined
        ? invocation.chainEnd - invocation.chainStart
        : undefined,
    handlerMs:
      invocation.handlerStart !== undefined && invocation.handlerEnd !== undefined
        ? invocation.handlerEnd - invocation.handlerStart
        : undefined,
    hookTimings: ((context.hookData?.[TIMINGS] as HookTiming[] | undefined) ?? []).slice(),
    inputsReplaced: invocation.inputsReplaced === true,
    callbackReplaced: invocation.callbackReplaced === true,
    handlerBypassed: chainOutcomeKnown && invocation.handlerRan !== true,
    resultAlteredByWrappers:
      chainOutcomeKnown && invocation.handlerRan === true && invocation.chainResult !== invocation.handlerResult,
    resultAlteredByPostHooks:
      chainOutcomeKnown && invocation.chainThrew !== true && context.result !== invocation.chainResult,
    errorAlteredByPostHooks: chainOutcomeKnown
      ? invocation.chainThrew === true
        ? context.error !== invocation.chainError
        : context.error != null
      : false,
  }
  if (state.options.onReport) {
    try {
      state.options.onReport(report)
    } catch (err) {
      recover('azure-functions preset: onReport callback', err)
    }
  } else {
    debug(
      `azure-functions preset: ${report.functionName ?? 'invocation'} total ${report.totalMs.toFixed(2)}ms, ` +
        `handler ${report.handlerMs?.toFixed(2) ?? '?'}ms, ${report.hookTimings.length} foreign hook(s)`,
    )
  }
}

/**
 * The `registerHook` choke point: attribute the registration, time pre/post
 * callbacks, and keep this preset's hooks at the positions that make the
 * bracket true — re-appended to the tail after every foreign registration.
 */
function chokePointRegisterHook(state: PresetState) {
  return function registerHook(hookName: string, callback: (context: never) => unknown): CoreDisposable {
    const { registrant, frame } = attributeRegistrant(new Error().stack)
    notifyRegistration(state, { hookName, registrant, frame })
    let toRegister = callback
    if ((hookName === 'preInvocation' || hookName === 'postInvocation') && typeof callback === 'function') {
      toRegister = timeForeignHook(hookName, registrant, callback) as (context: never) => unknown
    }
    const disposable = state.register(hookName, toRegister)
    // ours must execute after every foreign hook, and the only ordering the
    // worker knows is array position: re-append (dispose splices, register
    // pushes) so the bracket's closing side stays at the tail
    if (hookName === 'preInvocation') {
      state.preLastDisposable.dispose()
      state.preLastDisposable = state.register('preInvocation', preLastHook as (context: never) => unknown)
    } else if (hookName === 'postInvocation') {
      state.postLastDisposable.dispose()
      state.postLastDisposable = state.register('postInvocation', ((context: CorePostInvocationContext) =>
        postLastHook(context, state)) as unknown as (context: never) => unknown)
    }
    return disposable
  }
}

/** Whether the bracket is installed in this process. */
export function azureFunctionsActive(): boolean {
  return (globalSlots[STATE_SLOT] as PresetState | undefined)?.active === true
}

/** Every hook registration observed since activation, in order. */
export function azureHookRegistrations(): readonly HookRegistration[] {
  return ((globalSlots[STATE_SLOT] as PresetState | undefined)?.registrations ?? []).slice()
}

/**
 * Install the bracket now: requires the worker-served core module, registers
 * this preset's three hooks (pre first, pre last, post last), and patches
 * `registerHook` on the shared core object so every later registration is
 * observed and the tail positions hold. Returns false — and stays retriable —
 * when the core module is not being served yet; true once active (idempotent,
 * across preset copies too).
 *
 * Call this directly from a `package.json` "main" prelude (the delivery Azure
 * itself recommends for agents, since custom worker arguments forfeit
 * prewarmed workers): by the time any user module runs, worker setup is done
 * and the core module is there.
 */
export function activateAzureFunctions(options: AzureFunctionsOptions = {}): boolean {
  if (isDisabled()) return false
  const existing = globalSlots[STATE_SLOT] as PresetState | undefined
  if (existing?.active) return true
  const core = tryRequireCore()
  if (core === undefined) return false
  const register = core.registerHook.bind(core)
  const state: PresetState = {
    active: true,
    options,
    registrations: [],
    register,
    // placeholders, replaced two lines down — the object must exist for the
    // choke point to close over
    preLastDisposable: { dispose: () => {} },
    postLastDisposable: { dispose: () => {} },
  }
  register('preInvocation', preFirstHook as (context: never) => unknown)
  state.preLastDisposable = register('preInvocation', preLastHook as (context: never) => unknown)
  state.postLastDisposable = register('postInvocation', ((context: CorePostInvocationContext) =>
    postLastHook(context, state)) as unknown as (context: never) => unknown)
  core.registerHook = chokePointRegisterHook(state)
  globalSlots[STATE_SLOT] = state
  debug('azure-functions preset: bracket active (pre first, pre last, post last; registerHook choke point installed)')
  return true
}

/**
 * Arm for preload delivery (`languageWorkers__node__arguments` /
 * `NODE_OPTIONS` with `--import`): at preload the worker has not run yet and
 * the core module is not being served, so activation happens at the earliest
 * load event where it is — a load event fires before its module's body
 * evaluates, so this always beats the first line of user code, which is the
 * earliest anyone else can register a hook. The polling hook deregisters
 * itself on success; a miss costs one failed require per load until then.
 */
export function armAzureFunctions(options: AzureFunctionsOptions = {}): void {
  if (isDisabled()) return
  if (activateAzureFunctions(options)) return
  if (typeof nodeModule.registerHooks !== 'function') {
    recover(
      'azure-functions preset: arming',
      new Error(`Node ${process.version} has no module.registerHooks (needs >= 22.15)`),
    )
    return
  }
  const registered = nodeModule.registerHooks({
    load(url, context, nextLoad) {
      try {
        if (activateAzureFunctions(options)) registered.deregister()
      } catch (err) {
        recover('azure-functions preset: activating at load', err)
      }
      return nextLoad(url, context)
    },
  })
}

/**
 * The config-spread shape, mirroring the aws-lambda preset: arms the bracket
 * when the config is evaluated inside an Azure Functions worker
 * (FUNCTIONS_WORKER_RUNTIME is set — the host sets it, Core Tools' `func
 * start` requires it in local.settings.json) and stays inert anywhere else,
 * so one package can ship both. Emits no patch entries — the bracket rides
 * the platform's hook pipeline, not a file transform — but keeps the entry
 * shape so a config reads uniformly:
 *
 * ```js
 * export default definePatches(
 *   [...azureFunctionsEntries({ onReport: (r) => console.log(r) })],
 *   import.meta.url,
 * )
 * ```
 */
export function azureFunctionsEntries(options: AzureFunctionsOptions = {}): PatchEntry[] {
  if (process.env.FUNCTIONS_WORKER_RUNTIME === undefined && options.force !== true) {
    debug('azure-functions preset: no FUNCTIONS_WORKER_RUNTIME in the environment — inert')
    return []
  }
  armAzureFunctions(options)
  return []
}
