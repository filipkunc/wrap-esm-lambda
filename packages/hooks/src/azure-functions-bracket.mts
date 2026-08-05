// The bracket itself: the preset's three hooks (pre first, pre last, post
// last), the foreign-hook timing wrapper, and the `registerHook` choke
// point that attributes every registration and keeps the closing hooks at
// the tail. See azure-functions.mts for why these positions are the entire
// ordering contract.
import { debug, recover } from '@wrap-esm-lambda/core/diagnostics'
import type {
  CoreDisposable,
  CoreHookContext,
  CorePreInvocationContext,
  CorePostInvocationContext,
  FunctionCallback,
  HookData,
} from './azure-functions-core-api.mjs'
import type {
  AzureInvocationReport,
  HookRegistration,
  HookTiming,
  InvocationState,
  PresetState,
} from './azure-functions-state.mjs'
import { INVOCATION_STATE, TIMINGS } from './azure-functions-state.mjs'
import { now, observeCompletion } from './azure-functions-timing.mjs'
import type { CallbackOutcome } from './azure-functions-timing.mjs'

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
    if (/azure-functions[^\\/]*\.m[tj]s/.test(frame)) continue // this preset's files (src and dist alike)
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
    return observeCompletion(
      () => callback(context as never),
      (at) => recordTiming(context, { hookName, registrant, ms: at - start }),
    )
  }
}

/** Wrap a function callback, timing it and capturing its outcome into `state`. */
function wrapCallback(
  callback: FunctionCallback,
  state: InvocationState,
  markStart: (state: InvocationState, at: number) => void,
  markEnd: (state: InvocationState, at: number, outcome: CallbackOutcome) => void,
): FunctionCallback {
  return function wrappedCallback(this: unknown, ...args: unknown[]): unknown {
    markStart(state, now())
    return observeCompletion(
      () => callback.apply(this, args),
      (at, outcome) => markEnd(state, at, outcome),
    )
  }
}

/** Runs first among pre hooks: opens the bracket, wraps the handler innermost. */
export function preFirstHook(context: CorePreInvocationContext): void {
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
export function preLastHook(context: CorePreInvocationContext): void {
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
export function postLastHook(this: void, context: CorePostInvocationContext, state: PresetState): void {
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
export function chokePointRegisterHook(state: PresetState) {
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
