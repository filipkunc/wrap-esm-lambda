// Which entries apply to which module: package-identity matching (nearest
// package.json name + semver range + file suffixes) or path matching
// (`module.path`, for code with no package identity), and the builtin
// split — builtin targets never match a file and are handed to the runtime
// shell for eager preload patching instead.
import { isBuiltin } from 'node:module'
import { satisfies } from './range.mjs'
import { cleanPath } from './paths.mjs'
import { nearestPackageValue } from './package-walk.mjs'
import type { InstrumentConfig, InstrumentEntry, PackageModuleMatch, PatchEntry } from './config.mjs'

/** Identity of the package a file belongs to, from its nearest package.json. */
export interface PackageInfo {
  name: string
  version: string
  root: string
}

// Nearest NAMED package.json (nameless type markers are skipped — the walk
// keeps climbing), cached per directory by the shared walk.
const packageCache = new Map<string, PackageInfo | undefined>()

export function nearestPackage(filePath: string): PackageInfo | undefined {
  return nearestPackageValue(
    filePath,
    packageCache,
    (pkg, dir) => {
      if (typeof pkg.name !== 'string' || pkg.name === '') return undefined
      return { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', root: dir }
    },
    undefined,
  )
}

/** The `path` / `files` rule: an absolute candidate exactly, a suffix otherwise. */
function pathMatches(path: string, candidate: string): boolean {
  const clean = candidate.replaceAll('\\', '/')
  return path === clean || path.endsWith(`/${clean}`)
}

function entryMatches(entry: InstrumentEntry, path: string): boolean {
  // Path-identified modules (an app's own files, a Lambda handler located
  // via the runtime environment) carry no package identity at all — the
  // path list IS the match.
  if (entry.module.path !== undefined) {
    const candidates = typeof entry.module.path === 'string' ? [entry.module.path] : entry.module.path
    return candidates.some((candidate) => pathMatches(path, candidate))
  }
  // Built-in targets (node:http, ...) have no source for a load hook or
  // bundler to transform — they never match a file. The runtime shell
  // patches them eagerly at preload; the build shell aliases their
  // specifiers to generated wrapper modules (see builtinPatchEntries and
  // builtins.mjs).
  if (isBuiltin(entry.module.name)) return false
  const pkg = nearestPackage(path)
  if (!pkg || pkg.name !== entry.module.name) return false
  if (entry.module.versionRange && !satisfies(pkg.version, entry.module.versionRange)) return false
  if (entry.module.files && !entry.module.files.some((f) => pathMatches(path, f))) return false
  return true
}

/** All entries matching a module id (bundlers) or file URL (loader hooks). */
export function matchEntries(config: InstrumentConfig, idOrUrl: string): InstrumentEntry[] {
  const path = cleanPath(idOrUrl)
  return config.entries.filter((entry) => entryMatches(entry, path))
}

/** First matching entry — kept for callers that predate multi-entry matching. */
export function createMatcher(config: InstrumentConfig): (idOrUrl: string) => InstrumentEntry | undefined {
  return (idOrUrl) => matchEntries(config, idOrUrl)[0]
}

/**
 * The patch entries of a config that target Node built-ins (`node:http`,
 * `os`, ...), version-gated against the running Node. Built-ins have no
 * module source, so neither shell can reach them by transform — but a
 * declarative config knows its targets up front, so the runtime shell
 * patches the builtin's exports object eagerly at preload, before any user
 * code loads. Every consumer shape then observes the patch — `require()`,
 * ESM default import and ESM named import alike, because the ESM facade for
 * a core module is created at its first import, which preload precedes.
 * (`Module._load` interception — the classic route to built-ins — only ever
 * covered `require()`: `import` of a builtin has never flowed through it,
 * see hooks/interplay-matrix.) `versionRange` on a builtin entry gates on
 * `process.versions.node`; `files` is meaningless there and rejected loudly.
 */
/** A patch entry known to target a builtin — `module.name` is always set. */
export type BuiltinPatchEntry = PatchEntry & { module: PackageModuleMatch }

export function builtinPatchEntries(config: InstrumentConfig): BuiltinPatchEntry[] {
  return config.entries.filter((entry): entry is BuiltinPatchEntry => {
    if (entry.module.name === undefined || !isBuiltin(entry.module.name)) return false
    if (entry.module.files) {
      throw new TypeError(`builtin patch entry '${entry.module.name}' cannot have 'files' — built-ins are one module`)
    }
    return !entry.module.versionRange || satisfies(process.versions.node, entry.module.versionRange)
  })
}
