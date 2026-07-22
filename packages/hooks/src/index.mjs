// Runtime shell of the hybrid setup: instruments matched modules as they
// load, via Node's synchronous `module.registerHooks` — which covers both
// import and require, so patch entries reach CJS (e.g. AWS SDK dist-cjs) and
// ESM alike. Activate with `node --import @wrap-esm-lambda/hooks/register`
// (config path in WRAP_ESM_LAMBDA_CONFIG) or call `registerConfig(config)`.
// The transforms are the same native calls the build-time shell runs, so the
// cold start cost is microseconds per matched module.
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import {
  matchEntries,
  applyMatched,
  inlineMap,
  builtinPatchEntries,
  PATCH_REGISTRY,
  patchKey,
} from '@wrap-esm-lambda/core'

/**
 * Build a `registerHooks`-compatible load hook from a config. Patch taps are
 * emitted in registry delivery: they carry no injected import, and expect
 * `preloadPatches` to have populated the global registry first.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export function createLoadHook(config) {
  return function load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const entries = matchEntries(config, url)
    if (entries.length === 0) {
      return result
    }
    // `nextLoad` delivers the source as a UTF-8 Buffer; hand it over as-is.
    // For patch-only matches the source never leaves UTF-8 (zero-copy across
    // napi, one Buffer.concat) and `applied.code` comes back as a Buffer,
    // which a load hook may return directly — decoding to a string here cost
    // two O(n) encoding conversions per matched module for nothing.
    const applied = applyMatched(result.source, entries, url, {
      format: result.format,
      delivery: 'registry',
    })
    if (!applied) {
      // already instrumented (e.g. at build time) — never double-wrap
      return result
    }
    const source = applied.map ? inlineMap(applied.code, applied.map) : applied.code
    // Pass nextLoad's format through untouched. Inventing one when it is
    // undefined (e.g. a require()d .js file in a package without "type" on
    // newer Node) would mislabel CommonJS as ESM and crash its require calls;
    // with no format Node detects it from the returned source, and every line
    // the tap appends is format-neutral.
    const out = { shortCircuit: true, source }
    if (result.format != null) {
      out.format = result.format
    }
    return out
  }
}

/**
 * Import every patch module of the config and store its patch functions in
 * the global registry the emitted taps read from. Runs before the hook is
 * registered, in ordinary top-level ESM context — so TypeScript patch files
 * work wherever Node's type stripping does.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export async function preloadPatches(config) {
  const registry = (globalThis[PATCH_REGISTRY] ??= Object.create(null))
  for (const entry of config.entries) {
    if (!entry.patch) continue
    const spec = isAbsolute(entry.patch.from) ? pathToFileURL(entry.patch.from).href : entry.patch.from
    const mod = await import(spec)
    const fn = mod[entry.patch.name]
    if (typeof fn !== 'function') {
      throw new TypeError(`patch '${entry.patch.name}' is not exported by ${entry.patch.from}`)
    }
    registry[patchKey(entry)] = fn
  }
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
 * Mirrors the tap's validation contract: a requested binding missing from
 * the builtin is a hard error — the version-drift alarm.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export function applyBuiltinPatches(config) {
  const registry = globalThis[PATCH_REGISTRY] ?? Object.create(null)
  for (const entry of builtinPatchEntries(config)) {
    const target = requireBuiltin(entry.module.name)
    const accessors = {}
    for (const name of entry.bindings) {
      if (!(name in target)) {
        const available = Object.keys(target).slice(0, 20).join(', ')
        throw new TypeError(`binding '${name}' not found in ${entry.module.name} (available: ${available}, ...)`)
      }
      Object.defineProperty(accessors, name, {
        enumerable: true,
        get: () => target[name],
        set: (value) => {
          target[name] = value
        },
      })
    }
    registry[patchKey(entry)](accessors)
  }
}

/**
 * Preload the config's patch functions, apply builtin patches eagerly, then
 * register the load hook for everything with a source to transform.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export async function registerConfig(config) {
  await preloadPatches(config)
  applyBuiltinPatches(config)
  registerHooks({ load: createLoadHook(config) })
}
