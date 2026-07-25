// Resolution of names forwarded by bare `export * from "m"` statements.
// Those names are not statically visible in the re-exporting module alone,
// but they ARE knowable at transform time: we hold the module's path, so we
// can read and parse each star source (recursively — the same walk Node's
// linker and iitm's export scanner perform) and learn which source provides
// a requested name. The tap then reroutes that name through an append-only
// shadow export: an explicit named export shadows `export *` for the same
// name, so the star statement never needs touching. Relative sources
// (`./x.js`) resolve by plain path join; bare specifiers
// (`export * from "lodash-es"`) go through the engine's `resolveModule` —
// full import-style resolution (oxc_resolver natively, its JS twin in the
// acorn engine). Resolution only informs the walk: the emitted shadow
// export keeps importing from the specifier as written, so Node or the
// bundler still performs its own resolution in the output.
//
// Deliberate limits, all loud:
// - a name provided by MORE THAN ONE star source is ambiguous per the spec
//   (importers get a linking error for it) and is refused;
// - a star source that parses to no exports (e.g. a CJS file, whose names
//   Node derives at runtime) simply cannot provide the name statically;
// - a specifier that does not resolve (package not installed) provides
//   nothing, and the not-found error names the unresolved sources.
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { esmModuleExports, resolveModule } from './engine.mjs'
import type { EsmExportsInfo, TapEntryInput, TapResult, TapStarResolution } from './engine.mjs'

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/**
 * The file behind a star source specifier, from the directory of the module
 * that wrote it — a cheap path join for relative sources, the engine's full
 * import-style resolution for everything else. Null when nothing resolves.
 */
function starSourcePath(specifier: string, fromDir: string): string | null {
  if (isRelative(specifier)) return resolvePath(fromDir, specifier)
  return resolveModule(specifier, fromDir)
}

/** Parse cache for the walk: absolute path -> { names, starSources }. */
function moduleInfo(absPath: string, cache: Map<string, EsmExportsInfo>): EsmExportsInfo {
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
function providesName(absPath: string, name: string, cache: Map<string, EsmExportsInfo>, seen: Set<string>): boolean {
  if (seen.has(absPath)) return false
  seen.add(absPath)
  const info = moduleInfo(absPath, cache)
  if (info.names.includes(name)) return true
  return info.starSources.some((specifier) => {
    const source = starSourcePath(specifier, dirname(absPath))
    return source !== null && providesName(source, name, cache, seen)
  })
}

/**
 * For each requested name missing from the module's own exports, find the
 * bare-star source that provides it. Returns `starResolutions` for the tap
 * retry. Throws on ambiguity (two sources provide the name); names no
 * source provides stay unresolved — the caller rethrows the original
 * not-found error.
 *
 * @param starSources bare-star specifiers of the target module
 * @param modulePath absolute path of the target module
 */
export function resolveStarBindings(
  missingNames: Iterable<string>,
  starSources: string[],
  modulePath: string,
): TapStarResolution[] {
  const cache = new Map<string, EsmExportsInfo>()
  const dir = dirname(modulePath)
  const resolutions: TapStarResolution[] = []
  for (const name of missingNames) {
    const providers = starSources.filter((specifier) => {
      const source = starSourcePath(specifier, dir)
      return source !== null && providesName(source, name, cache, new Set())
    })
    if (providers.length > 1) {
      throw new Error(
        `export '${name}' is ambiguous: provided by multiple 'export *' sources (${providers.join(', ')}) — importers cannot resolve it either; patch the defining module instead`,
      )
    }
    if (providers.length === 1) {
      resolutions.push({ binding: name, source: providers[0]! })
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
export type BoundTap = (
  entries: TapEntryInput[],
  cjs: boolean,
  registry: boolean,
  filename: string,
  upstreamMap: string | undefined,
  starResolutions: TapStarResolution[] | undefined,
) => TapResult

export function tapWithStarRetry(
  tap: BoundTap,
  decode: () => string,
  modulePath: string,
  entriesInput: TapEntryInput[],
  cjs: boolean,
  registry: boolean,
  filename: string,
  upstreamMap: string | undefined,
): TapResult {
  try {
    return tap(entriesInput, cjs, registry, filename, upstreamMap, undefined)
  } catch (err) {
    if (cjs || !/not found in module/.test(err instanceof Error ? err.message : String(err))) throw err
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
