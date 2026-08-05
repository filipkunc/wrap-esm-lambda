// Runtime shell of the hybrid setup: instruments matched modules as they
// load, via Node's synchronous `module.registerHooks` — which covers both
// import and require, so patch entries reach CJS (e.g. AWS SDK dist-cjs) and
// ESM alike. Activate with `node --import @wrap-esm-lambda/hooks/register`
// (config path in WRAP_ESM_LAMBDA_CONFIG) or call `registerConfig(config)`.
// The transforms are the same native calls the build-time shell runs, so the
// cold start cost is microseconds per matched module.
//
// This shell owns the runtime failure policy (core's transforms themselves
// always throw — see core's diagnostics.mjs). Everything downstream of a
// valid config degrades instead of failing: a patch module that will not
// import drops its entry, a builtin whose binding moved is skipped, a module
// whose transform throws loads untouched, and a patch function that throws is
// contained. Each of those reports once on stderr, is retrievable via core's
// `instrumentationFailures()`, and becomes a throw again under
// WRAP_ESM_LAMBDA_STRICT=1. The whole shell is off under
// WRAP_ESM_LAMBDA_DISABLE=1.
import * as nodeModule from 'node:module'
import { createRequire, isBuiltin } from 'node:module'
import type { LoadFnOutput, LoadHookSync } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import type { InstrumentConfig, PatchFunction, PatchRegistry } from '@wrap-esm-lambda/core'
import {
  matchEntries,
  applyMatched,
  inlineMap,
  builtinPatchEntries,
  builtinAccessors,
  builtinGuardKey,
  engineName,
  runtimeFormatFor,
  PATCH_REGISTRY,
  patchKey,
  DEBUG,
  debug,
  isDisabled,
  recover,
} from '@wrap-esm-lambda/core'

/**
 * What a guarded patch function returns when the user's patch threw and the
 * failure was recovered from — the one caller that cares is the builtin path,
 * which must not set its hybrid double-patch guard for a patch that did not
 * actually apply.
 */
const PATCH_FAILED = Symbol('wrap-esm-lambda.patchFailed')

/**
 * `globalThis` as the two process-global slots this shell uses see it: the
 * patch registry the emitted taps read, and the per-entry builtin guards
 * shared with the build shell's generated wrapper.
 */
const globalSlots = globalThis as unknown as Record<symbol, unknown>

/**
 * Wrap a user patch function so a throw inside it cannot break the evaluation
 * of the module being patched. The emitted tap calls the registry entry
 * directly from the patched module's own body, so without this an exception in
 * patch code — or from the tap's verified setter, which throws when a rebind
 * silently no-ops on getter-only bundled CJS — propagates as a module load
 * failure and the app never starts.
 */
function guardPatch(key: string, fn: PatchFunction): PatchFunction {
  return function guardedPatch(accessors: Record<string, unknown>) {
    try {
      fn(accessors)
      return undefined
    } catch (err) {
      recover(`patch '${key}'`, err)
      return PATCH_FAILED
    }
  }
}

/**
 * Build a `registerHooks`-compatible load hook from a config. Patch taps are
 * emitted in registry delivery: they carry no injected import, and expect
 * `preloadPatches` to have populated the global registry first.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export function createLoadHook(config: InstrumentConfig): LoadHookSync {
  // Modules whose instrumentation already failed once: a repeated load (worker
  // threads, vm contexts, a watch-mode reload) must not re-pay the failed
  // transform, and one broken dependency must not flood stderr.
  const failed = new Set<string>()
  return function load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (failed.has(url)) {
      return result
    }
    try {
      const entries = matchEntries(config, url)
      if (entries.length === 0) {
        return result
      }
      if (result.source == null) {
        // nothing to transform: `nextLoad` omits the source for what Node
        // loads without one (a builtin, a native addon), and for a CJS module
        // whose evaluation Node handles itself
        debug(`skip (no source): ${url}`)
        return result
      }
      // `nextLoad` delivers the source as a UTF-8 Buffer; hand it over as-is.
      // For patch-only matches the source never leaves UTF-8 (zero-copy across
      // napi, one Buffer.concat) and `applied.code` comes back as a Buffer,
      // which a load hook may return directly — decoding to a string here cost
      // two O(n) encoding conversions per matched module for nothing.
      // nextLoad reports no format for require()d .js files — fall back to the
      // format Node itself will assign (extension, then nearest package.json
      // "type"), so a pure-CJS express is never parsed as ESM and each tree of
      // a dual package (hono dist/ vs dist/cjs/) gets its real kind.
      const applied = applyMatched(result.source, entries, url, {
        format: result.format ?? runtimeFormatFor(url),
        delivery: 'registry',
      })
      if (!applied) {
        // already instrumented (e.g. at build time) — never double-wrap
        debug(`skip (already instrumented): ${url}`)
        return result
      }
      const source = applied.map ? inlineMap(applied.code, applied.map) : applied.code
      if (DEBUG) {
        const shape = applied.map ? ', rewritten' : ''
        debug(`instrumented ${url} (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${shape})`)
      }
      // Pass nextLoad's format through untouched. Inventing one when it is
      // undefined (e.g. a require()d .js file in a package without "type" on
      // newer Node) would mislabel CommonJS as ESM and crash its require calls;
      // with no format Node detects it from the returned source, and every line
      // the tap appends is format-neutral.
      const out: LoadFnOutput = { shortCircuit: true, source, format: undefined }
      if (result.format != null) {
        out.format = result.format
      }
      return out
    } catch (err) {
      // One module failing to instrument must not fail its LOAD. The loud
      // errors this catches are the design's own alarms — a binding that moved
      // in a dependency bump, an ambiguous bare `export *`, a source the parser
      // rejects — and every one of them arrives from a third-party module the
      // app merely depends on. Losing the patch is degraded observability;
      // failing the load is an outage.
      failed.add(url)
      recover(`instrumenting ${url}`, err)
      return result
    }
  }
}

/**
 * Import every patch module of the config and store its patch functions in
 * the global registry the emitted taps read from. Runs before the hook is
 * registered, in ordinary top-level ESM context — so TypeScript patch files
 * work wherever Node's type stripping does.
 *
 * A patch module that will not import (a typo in `from`, a dependency the app
 * does not have, a syntax error in patch code) drops just its own entry: the
 * returned config carries the entries that are actually deliverable, so no
 * module gets a tap whose patch could never run.
 *
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 * @returns {Promise<import('@wrap-esm-lambda/core').InstrumentConfig>} the
 *   config restricted to entries whose patch function is now registered
 */
export async function preloadPatches(config: InstrumentConfig): Promise<InstrumentConfig> {
  const registry = (globalSlots[PATCH_REGISTRY] ??= Object.create(null) as PatchRegistry) as PatchRegistry
  const entries: InstrumentConfig['entries'] = []
  for (const entry of config.entries) {
    const key = patchKey(entry)
    try {
      const spec = isAbsolute(entry.patch.from) ? pathToFileURL(entry.patch.from).href : entry.patch.from
      const mod = (await import(spec)) as Record<string, unknown>
      const fn = mod[entry.patch.name]
      if (typeof fn !== 'function') {
        throw new TypeError(`patch '${entry.patch.name}' is not exported by ${entry.patch.from}`)
      }
      registry[key] = guardPatch(key, fn as PatchFunction)
      entries.push(entry)
    } catch (err) {
      recover(`loading patch '${key}'`, err)
    }
  }
  return { ...config, entries }
}

const requireBuiltin = createRequire(import.meta.url)

/**
 * Eagerly patch the config's builtin targets (`node:http`, `os`, ...): no
 * source exists to transform, so the patch function runs right now, at
 * preload, against the builtin's live exports object — before any user code
 * (or the load hook itself) exists. `require()`, ESM default import and ESM
 * named import all observe it, because the ESM facade for a core module is
 * created at first import, which this precedes. This never touches
 * `Module._load`, so it works identically on the pre-fix Node minors where
 * sync hooks and the patch point miscomposed (see hooks/interplay-matrix —
 * `builtin-eager-patch` is PATCHED_ALL on every rung).
 *
 * Mirrors the tap's validation contract: a requested binding missing from the
 * builtin is the version-drift alarm — reported and skipped (thrown under
 * WRAP_ESM_LAMBDA_STRICT), per entry, so one moved binding costs one patch
 * rather than the process.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export function applyBuiltinPatches(config: InstrumentConfig): void {
  const registry = (globalSlots[PATCH_REGISTRY] ?? Object.create(null)) as PatchRegistry
  for (const entry of builtinPatchEntries(config)) {
    // hybrid guard, shared with the build shell's generated wrapper: when a
    // bundle already carries this entry's builtin patch, skip it here — the
    // builtin's exports object is process-global, so applying twice would
    // wrap its methods twice
    const guard = Symbol.for(builtinGuardKey(entry))
    if (globalSlots[guard]) continue
    const key = patchKey(entry)
    const patch = registry[key]
    if (patch === undefined) {
      // preloadPatches dropped this entry — nothing to apply
      debug(`skip builtin ${entry.module.name}: patch '${key}' is not registered`)
      continue
    }
    try {
      const target = requireBuiltin(entry.module.name) as Record<string, unknown>
      const accessors = builtinAccessors(target, entry.module.name, entry.bindings)
      // The guard is marked only once the patch has actually applied: setting
      // it up front would make a failed patch look done to the build shell's
      // generated wrapper as well, leaving the builtin with no patch at all.
      if (patch(accessors) !== PATCH_FAILED) {
        globalSlots[guard] = true
        debug(`patched builtin ${entry.module.name}`)
      }
    } catch (err) {
      recover(`patching builtin '${entry.module.name}'`, err)
    }
  }
}

/**
 * Preload the config's patch functions, apply builtin patches eagerly, then
 * register the load hook for everything with a source to transform.
 *
 * Off entirely under WRAP_ESM_LAMBDA_DISABLE=1 — the lever for taking
 * instrumentation out of a running deployment without editing its start
 * command. On a Node without `module.registerHooks` (< 22.15) the builtin
 * patches still apply and the missing hook is reported, instead of the process
 * dying on an import of something that isn't there.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export async function registerConfig(config: InstrumentConfig): Promise<void> {
  if (isDisabled()) {
    debug('disabled by WRAP_ESM_LAMBDA_DISABLE — no patches, no hooks')
    return
  }
  const active = await preloadPatches(config)
  applyBuiltinPatches(active)
  // Builtin entries never match a file, so a config with nothing else needs
  // no load hook — and no engine: the transform engine binds lazily on first
  // use, and for an inert config (e.g. the aws-lambda preset outside Lambda)
  // first use never comes.
  const fileEntries = active.entries.filter((entry) => entry.module.name === undefined || !isBuiltin(entry.module.name))
  if (fileEntries.length === 0) {
    debug('no file-matched entries — load hook not registered, engine not loaded')
    return
  }
  if (typeof nodeModule.registerHooks !== 'function') {
    recover(
      'registering the load hook',
      new Error(
        `Node ${process.version} has no module.registerHooks (needs >= 22.15) — ` +
          `use @wrap-esm-lambda/unplugin to instrument at build time instead`,
      ),
    )
    return
  }
  // Bind the engine NOW, not inside the first module's synchronous load
  // hook: an engine that is missing or mismatched (WRAP_ESM_LAMBDA_ENGINE
  // names one that cannot load) must be a loud startup failure, and the
  // fallback warning belongs at startup too.
  debug(`engine bound at register: ${engineName()}`)
  nodeModule.registerHooks({ load: createLoadHook(active) })
  debug(`load hook registered for ${active.entries.length} ${active.entries.length === 1 ? 'entry' : 'entries'}`)
}
