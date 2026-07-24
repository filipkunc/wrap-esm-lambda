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

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readPackageJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** A path as a file: exact, then completed with an extension. */
function resolveAsFile(path) {
  if (isFile(path)) return path
  for (const ext of EXTENSIONS) {
    if (isFile(path + ext)) return path + ext
  }
  return null
}

/** A path as a directory: entry fields of its package.json, then index files. */
function resolveAsDirectory(dir) {
  const pkg = readPackageJson(dir)
  for (const field of ['module', 'main']) {
    if (typeof pkg?.[field] === 'string') {
      const entry = resolveAsFile(join(dir, pkg[field])) ?? resolveAsDirectory(join(dir, pkg[field]))
      if (entry) return entry
    }
  }
  return resolveAsFile(join(dir, 'index'))
}

function resolveFileOrDirectory(path) {
  const asFile = resolveAsFile(path)
  if (asFile) return asFile
  return isDirectory(path) ? resolveAsDirectory(path) : null
}

/**
 * One `"exports"` target resolved against the package root: strings resolve
 * (with `*` filled in for pattern keys), condition objects take the first
 * matching condition, arrays take the first entry that resolves.
 */
function resolveExportsTarget(pkgDir, target, starMatch) {
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
    for (const [condition, value] of Object.entries(target)) {
      if (CONDITIONS.has(condition)) {
        const resolved = resolveExportsTarget(pkgDir, value, starMatch)
        if (resolved) return resolved
      }
    }
  }
  return null
}

/** The package `"exports"` map resolved for a subpath ('.' or './sub'). */
function resolveExports(pkgDir, exports, subpath) {
  // sugar: a bare string / array / condition object is the "." entry
  const isSubpathMap =
    exports !== null &&
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports).every((key) => key.startsWith('.'))
  if (!isSubpathMap) {
    return subpath === '.' ? resolveExportsTarget(pkgDir, exports, null) : null
  }
  if (Object.hasOwn(exports, subpath)) {
    return resolveExportsTarget(pkgDir, exports[subpath], null)
  }
  // longest-prefix `./x/*` pattern match, the spec's PATTERN_KEY_COMPARE order
  let best = null
  for (const key of Object.keys(exports)) {
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
  return best === null ? null : resolveExportsTarget(pkgDir, exports[best.key], best.match)
}

/** Split a bare specifier into package name and './'-prefixed subpath. */
function splitBareSpecifier(specifier) {
  const parts = specifier.split('/')
  const nameLength = specifier.startsWith('@') ? 2 : 1
  if (parts.length < nameLength || parts.slice(0, nameLength).some((p) => p === '')) return null
  const name = parts.slice(0, nameLength).join('/')
  const subpath = parts.length === nameLength ? '.' : `./${parts.slice(nameLength).join('/')}`
  return { name, subpath }
}

function resolveBare(specifier, fromDir) {
  const split = splitBareSpecifier(specifier)
  if (split === null) return null
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', split.name)
    if (isDirectory(pkgDir)) {
      const pkg = readPackageJson(pkgDir)
      if (pkg !== undefined && pkg.exports !== undefined) {
        return resolveExports(pkgDir, pkg.exports, split.subpath)
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
export function resolveModule(specifier, fromDir) {
  if (specifier.startsWith('node:')) return null
  const resolved =
    specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)
      ? resolveFileOrDirectory(resolvePath(fromDir, specifier))
      : resolveBare(specifier, fromDir)
  if (resolved === null) return null
  return existsSync(resolved) ? realpathSync(resolved) : null
}
