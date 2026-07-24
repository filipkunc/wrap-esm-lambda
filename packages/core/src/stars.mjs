// Resolution of names forwarded by bare `export * from "m"` statements.
// Those names are not statically visible in the re-exporting module alone,
// but they ARE knowable at transform time: we hold the module's path, so we
// can read and parse each star source (recursively — the same walk Node's
// linker and iitm's export scanner perform) and learn which source provides
// a requested name. The tap then reroutes that name through an append-only
// shadow export: an explicit named export shadows `export *` for the same
// name, so the star statement never needs touching.
//
// Deliberate limits, all loud:
// - only relative star sources (`./x.js`, `../y.js`) are followed — bare
//   specifiers (`export * from "lodash-es"`) would need full Node/bundler
//   resolution the transform doesn't own;
// - a name provided by MORE THAN ONE star source is ambiguous per the spec
//   (importers get a linking error for it) and is refused;
// - a star source that parses to no exports (e.g. a CJS file, whose names
//   Node derives at runtime) simply cannot provide the name statically.
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { esmModuleExports } from './engine.mjs'

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/** Parse cache for the walk: absolute path -> { names, starSources }. */
function moduleInfo(absPath, cache) {
  let info = cache.get(absPath)
  if (info === undefined) {
    try {
      info = esmModuleExports(readFileSync(absPath, 'utf8'))
    } catch {
      info = { names: [], starSources: [] }
    }
    cache.set(absPath, info)
  }
  return info
}

/** Does the module at absPath (transitively) export `name`? */
function providesName(absPath, name, cache, seen) {
  if (seen.has(absPath)) return false
  seen.add(absPath)
  const info = moduleInfo(absPath, cache)
  if (info.names.includes(name)) return true
  return info.starSources.some(
    (specifier) => isRelative(specifier) && providesName(resolvePath(dirname(absPath), specifier), name, cache, seen),
  )
}

/**
 * For each requested name missing from the module's own exports, find the
 * bare-star source that provides it. Returns `starResolutions` for the tap
 * retry. Throws on ambiguity (two sources provide the name); names no
 * source provides stay unresolved — the caller rethrows the original
 * not-found error.
 *
 * @param {Iterable<string>} missingNames
 * @param {string[]} starSources bare-star specifiers of the target module
 * @param {string} modulePath absolute path of the target module
 * @returns {{ binding: string, source: string }[]}
 */
export function resolveStarBindings(missingNames, starSources, modulePath) {
  const cache = new Map()
  const dir = dirname(modulePath)
  const resolutions = []
  for (const name of missingNames) {
    const providers = starSources.filter(
      (specifier) => isRelative(specifier) && providesName(resolvePath(dir, specifier), name, cache, new Set()),
    )
    if (providers.length > 1) {
      throw new Error(
        `export '${name}' is ambiguous: provided by multiple 'export *' sources (${providers.join(', ')}) — importers cannot resolve it either; patch the defining module instead`,
      )
    }
    if (providers.length === 1) {
      resolutions.push({ binding: name, source: providers[0] })
    }
  }
  return resolutions
}

/**
 * The native tap call with one star-resolution retry — the entry point
 * `applyMatched` uses. `tap` is the bound native function (string or buffer
 * variant), `decode` lazily yields the source text for the walk, and the
 * walk itself only runs when the first call fails on a name that a bare
 * `export * from` might forward. Names no star source provides rethrow the
 * original loud error; ambiguous names (two sources — importers cannot
 * link them either) throw their own.
 */
export function tapWithStarRetry(tap, decode, modulePath, entriesInput, cjs, registry, filename, upstreamMap) {
  try {
    return tap(entriesInput, cjs, registry, filename, upstreamMap, undefined)
  } catch (err) {
    if (cjs || !/not found in module/.test(String(err?.message))) throw err
    const sourceText = decode()
    const { names, starSources } = esmModuleExports(sourceText)
    if (starSources.length === 0) throw err
    const known = new Set(names)
    const missing = new Set(entriesInput.flatMap((entry) => entry.bindings).filter((name) => !known.has(name)))
    const resolutions = resolveStarBindings(missing, starSources, modulePath)
    if (resolutions.length === 0) throw err
    return tap(entriesInput, cjs, registry, filename, upstreamMap, resolutions)
  }
}
