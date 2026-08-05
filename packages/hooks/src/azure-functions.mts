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
//
// The preset is split along its seams: azure-functions-core-api.mts is the
// worker-served platform contract, azure-functions-state.mts the report and
// state model, azure-functions-timing.mts the generic async-outcome
// observation, azure-functions-bracket.mts the three hooks plus the
// registerHook choke point. This file owns the activation lifecycle.
import * as nodeModule from 'node:module'
import type { PatchEntry } from '@wrap-esm-lambda/core'
import { debug, isDisabled, recover } from '@wrap-esm-lambda/core/diagnostics'
import { tryRequireCore } from './azure-functions-core-api.mjs'
import type { CorePostInvocationContext } from './azure-functions-core-api.mjs'
import { STATE_SLOT, globalSlots } from './azure-functions-state.mjs'
import type { AzureFunctionsOptions, HookRegistration, PresetState } from './azure-functions-state.mjs'
import { chokePointRegisterHook, postLastHook, preFirstHook, preLastHook } from './azure-functions-bracket.mjs'

export type {
  AzureFunctionsOptions,
  AzureInvocationReport,
  HookRegistration,
  HookTiming,
} from './azure-functions-state.mjs'

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
