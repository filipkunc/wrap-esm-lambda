// The worker-served platform contract this preset programs against: the
// shapes of `@azure/functions-core` (nothing here is ours — see
// Azure/azure-functions-nodejs-worker), and the retriable require that
// reaches it. The module never exists as a file: the worker serves it from
// a `Module.prototype.require` proxy once its setup has run, which is why
// requiring it can legitimately fail and be retried later.
import { createRequire } from 'node:module'

/** The shapes this preset relies on from the worker-served core module. */
export interface CoreDisposable {
  dispose(): void
}
export type HookData = Record<string | symbol, unknown>
export interface CoreHookContext {
  readonly hookData: HookData
  readonly appHookData: HookData
}
export type FunctionCallback = (...args: unknown[]) => unknown
export interface CorePreInvocationContext extends CoreHookContext {
  readonly invocationContext: unknown
  inputs: unknown[]
  functionCallback: FunctionCallback
}
export interface CorePostInvocationContext extends CoreHookContext {
  readonly invocationContext: unknown
  inputs: unknown[]
  result: unknown
  error: unknown
}
export interface CoreApi {
  registerHook(hookName: string, callback: (context: never) => unknown): CoreDisposable
}

const requireCore = createRequire(import.meta.url)

/**
 * The worker serves `@azure/functions-core` from a require proxy the moment
 * `setupCoreModule` has run; before that the specifier resolves nowhere. A
 * miss here is retriable — unlike `@azure/functions`' own `tryGetCoreApiLazy`,
 * which caches the null forever.
 */
export function tryRequireCore(): CoreApi | undefined {
  try {
    const core = requireCore('@azure/functions-core') as CoreApi
    return typeof core?.registerHook === 'function' ? core : undefined
  } catch {
    return undefined
  }
}
