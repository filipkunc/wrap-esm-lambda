// The preset's data model: what one invocation's bracket reports (the
// public shapes consumers receive) and the state the bracket keeps to build
// it — per-invocation on the worker's own shared hookData, per-process in
// global slots so a second copy of the preset observes the first activation
// instead of double-bracketing every invocation.
import type { CoreApi, CoreDisposable, FunctionCallback } from './azure-functions-core-api.mjs'

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
export interface InvocationState {
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

export interface PresetState {
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
export const STATE_SLOT = Symbol.for('wrap-esm-lambda.azure-functions.state')
export const INVOCATION_STATE = Symbol.for('wrap-esm-lambda.azure-functions.invocation')
export const TIMINGS = Symbol.for('wrap-esm-lambda.azure-functions.timings')
export const globalSlots = globalThis as unknown as Record<symbol, unknown>
