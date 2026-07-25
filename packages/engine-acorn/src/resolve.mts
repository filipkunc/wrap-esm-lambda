// The JS twin of the native engine's `resolveModule` (oxc_resolver behind
// napi): resolve a specifier from a directory the way an `import` — or an
// ESM `export * from` — would. Core's star-graph walk uses this to follow
// bare-specifier stars: it needs the file behind `export * from "pkg"` to
// learn which names it provides, while the emitted shadow export keeps
// importing from the original specifier — resolution informs the transform
// and never lands in the output.
//
// Scope: the resolution real published packages need — `node_modules` walk,
// `"exports"` maps under the `node`/`import`/`default` conditions (subpath
// patterns, nested conditions, array fallbacks), `"module"` before `"main"`
// for map-less packages (the ESM tree is what a star re-export forwards),
// extension/index completion for legacy entries, and symlink-real paths
// (pnpm layouts). Unresolvable specifiers return null and the caller keeps
// its loud unresolved-star error — same contract as the native engine.
import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

const CONDITIONS = new Set(['node', 'import', 'default'])
const EXTENSIONS = ['.js', '.json', '.node']

/**
 * A package.json as this resolver reads it: only the entry fields matter, and
 * `exports` is arbitrary JSON — the recursive target resolution below narrows
 * it as it walks.
 */
interface PackageEntryFields {
  module?: unknown
  main?: unknown
  exports?: unknown
}

/** An `"exports"` value: a target string, a fallback array, or conditions. */
type ExportsValue = string | ExportsValue[] | { [key: string]: ExportsValue } | null

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readPackageJson(dir: string): PackageEntryFields | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageEntryFields
  } catch {
    return undefined
  }
}

/** A path as a file: exact, then completed with an extension. */
function resolveAsFile(path: string): string | null {
  if (isFile(path)) return path
  for (const ext of EXTENSIONS) {
    if (isFile(path + ext)) return path + ext
  }
  return null
}

/** A path as a directory: entry fields of its package.json, then index files. */
function resolveAsDirectory(dir: string): string | null {
  const pkg = readPackageJson(dir)
  for (const field of ['module', 'main'] as const) {
    const value = pkg?.[field]
    if (typeof value === 'string') {
      const entry = resolveAsFile(join(dir, value)) ?? resolveAsDirectory(join(dir, value))
      if (entry) return entry
    }
  }
  return resolveAsFile(join(dir, 'index'))
}

function resolveFileOrDirectory(path: string): string | null {
  const asFile = resolveAsFile(path)
  if (asFile) return asFile
  return isDirectory(path) ? resolveAsDirectory(path) : null
}

/**
 * One `"exports"` target resolved against the package root: strings resolve
 * (with `*` filled in for pattern keys), condition objects take the first
 * matching condition, arrays take the first entry that resolves.
 */
function resolveExportsTarget(pkgDir: string, target: ExportsValue, starMatch: string | null): string | null {
  if (typeof target === 'string') {
    const filled = starMatch === null ? target : target.replaceAll('*', starMatch)
    return resolveAsFile(join(pkgDir, filled))
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveExportsTarget(pkgDir, entry, starMatch)
      if (resolved) return resolved
    }
    return null
  }
  if (target !== null && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target as Record<string, ExportsValue>)) {
      if (CONDITIONS.has(condition)) {
        const resolved = resolveExportsTarget(pkgDir, value, starMatch)
        if (resolved) return resolved
      }
    }
  }
  return null
}

/** The package `"exports"` map resolved for a subpath ('.' or './sub'). */
function resolveExports(pkgDir: string, exports: ExportsValue, subpath: string): string | null {
  // sugar: a bare string / array / condition object is the "." entry
  const isSubpathMap =
    exports !== null &&
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports).every((key) => key.startsWith('.'))
  if (!isSubpathMap) {
    return subpath === '.' ? resolveExportsTarget(pkgDir, exports, null) : null
  }
  const map = exports as Record<string, ExportsValue>
  if (Object.hasOwn(map, subpath)) {
    return resolveExportsTarget(pkgDir, map[subpath]!, null)
  }
  // longest-prefix `./x/*` pattern match, the spec's PATTERN_KEY_COMPARE order
  let best: { key: string; prefix: string; match: string } | null = null
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*')
    if (star === -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      if (best === null || prefix.length > best.prefix.length) {
        best = { key, prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length) }
      }
    }
  }
  return best === null ? null : resolveExportsTarget(pkgDir, map[best.key]!, best.match)
}

/** Split a bare specifier into package name and './'-prefixed subpath. */
function splitBareSpecifier(specifier: string): { name: string; subpath: string } | null {
  const parts = specifier.split('/')
  const nameLength = specifier.startsWith('@') ? 2 : 1
  if (parts.length < nameLength || parts.slice(0, nameLength).some((p: string) => p === '')) return null
  const name = parts.slice(0, nameLength).join('/')
  const subpath = parts.length === nameLength ? '.' : `./${parts.slice(nameLength).join('/')}`
  return { name, subpath }
}

function resolveBare(specifier: string, fromDir: string): string | null {
  const split = splitBareSpecifier(specifier)
  if (split === null) return null
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', split.name)
    if (isDirectory(pkgDir)) {
      const pkg = readPackageJson(pkgDir)
      if (pkg !== undefined && pkg.exports !== undefined) {
        return resolveExports(pkgDir, pkg.exports as ExportsValue, split.subpath)
      }
      if (split.subpath !== '.') return resolveFileOrDirectory(join(pkgDir, split.subpath))
      return resolveAsDirectory(pkgDir)
    }
    if (dirname(dir) === dir) return null
  }
}

/**
 * Resolve `specifier` from `fromDir`. Returns the symlink-real absolute path
 * of the resolved file, or null when the specifier does not resolve — the
 * same surface as the native `resolveModule`.
 */
export function resolveModule(specifier: string, fromDir: string): string | null {
  if (specifier.startsWith('node:')) return null
  const resolved =
    specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)
      ? resolveFileOrDirectory(resolvePath(fromDir, specifier))
      : resolveBare(specifier, fromDir)
  if (resolved === null) return null
  return existsSync(resolved) ? realpathSync(resolved) : null
}
