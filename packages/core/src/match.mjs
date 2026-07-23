// Which entries apply to which module: package-identity matching for patch
// entries (nearest package.json name + semver range + file suffixes), path
// matching for wrap entries, and the builtin split — builtin targets never
// match a file and are handed to the runtime shell for eager preload
// patching instead.
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import semver from 'semver'
import { cleanPath } from './paths.mjs'

// Nearest-package.json lookup, cached per directory so the runtime hook stays
// cold-start-cheap across the many files of one package.
const packageCache = new Map()

/** @returns {{ name: string, version: string, root: string } | undefined} */
export function nearestPackage(filePath) {
  let dir = dirname(filePath)
  const visited = []
  while (true) {
    if (packageCache.has(dir)) {
      const hit = packageCache.get(dir)
      for (const d of visited) packageCache.set(d, hit)
      return hit
    }
    visited.push(dir)
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name) {
        const info = { name: pkg.name, version: pkg.version ?? '0.0.0', root: dir }
        for (const d of visited) packageCache.set(d, info)
        return info
      }
    } catch {
      // no package.json here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) {
      for (const d of visited) packageCache.set(d, undefined)
      return undefined
    }
    dir = parent
  }
}

function entryMatches(entry, path) {
  if (entry.match !== undefined) {
    return typeof entry.match === 'string' ? path.endsWith(entry.match) : entry.match.test(path)
  }
  if (entry.module !== undefined) {
    // Built-in targets (node:http, ...) have no source for a load hook or
    // bundler to transform — they never match a file. The runtime shell
    // patches them eagerly at preload instead (see builtinPatchEntries).
    if (isBuiltin(entry.module.name)) return false
    const pkg = nearestPackage(path)
    if (!pkg || pkg.name !== entry.module.name) return false
    if (entry.module.versionRange && !semver.satisfies(pkg.version, entry.module.versionRange)) return false
    if (entry.module.files && !entry.module.files.some((f) => path.endsWith(`/${f}`) || path === f)) return false
    return true
  }
  return false
}

/**
 * All entries matching a module id (bundlers) or file URL (loader hooks).
 * @param {import('./config.mjs').InstrumentConfig} config
 */
export function matchEntries(config, idOrUrl) {
  const path = cleanPath(idOrUrl)
  return config.entries.filter((entry) => entryMatches(entry, path))
}

/**
 * First matching entry — kept for callers that predate multi-entry matching.
 * @param {import('./config.mjs').InstrumentConfig} config
 */
export function createMatcher(config) {
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
 *
 * @param {import('./config.mjs').InstrumentConfig} config
 * @returns {import('./config.mjs').PatchEntry[]}
 */
export function builtinPatchEntries(config) {
  return config.entries.filter((entry) => {
    if (!entry.patch || !entry.module || !isBuiltin(entry.module.name)) return false
    if (entry.module.files) {
      throw new TypeError(`builtin patch entry '${entry.module.name}' cannot have 'files' — built-ins are one module`)
    }
    return !entry.module.versionRange || semver.satisfies(process.versions.node, entry.module.versionRange)
  })
}
