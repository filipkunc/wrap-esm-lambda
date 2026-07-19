// Shared core of the hybrid instrumentation setup: one declarative config,
// consumed by both the runtime shell (@wrap-esm-lambda/hooks, a
// `registerHooks` load hook) and the build-time shell
// (@wrap-esm-lambda/unplugin, a bundler plugin). Both shells call
// `applyMatched` below, so the instrumented code is byte-identical no matter
// which mode produced it.
//
// Two entry kinds exist:
// - wrap entries (`match` + `handler` + `wrapper`): AST-level rebind of an
//   exported const, the original Lambda-handler transform.
// - patch entries (`module` + `patch` + `bindings`): the generic exports tap —
//   Module._load-monkey-patching ergonomics, delivered by source transform.
//   The user's patch function receives the module's live bindings as get/set
//   accessors and does ordinary imperative patching against real objects.
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import semver from 'semver'
import { transformLambdaWithMapObject, exportsTapSnippet } from 'wrap-esm-lambda'

/**
 * Marker appended to every transformed module. Both shells skip sources that
 * already carry it, so running the runtime hook on top of a build-time
 * instrumented bundle never double-wraps. It is a legal comment (`/*!`) so
 * bundlers and minifiers keep it in the output by default — a regular comment
 * would be stripped and the guard lost. Detection keys on the inner text
 * only: esbuild's legal-comment hoisting rewrites the comment delimiters
 * (`/*! ... *\/` becomes `(*! ... *)` inside its license block), so matching
 * the full comment would silently defeat the guard on bundled output.
 */
export const SENTINEL_TEXT = '@wrap-esm-lambda instrumented'
export const SENTINEL = `/*! ${SENTINEL_TEXT} */`

/**
 * @typedef {Object} WrapperSpec
 * @property {string} name - identifier the wrapped export is called through, e.g. 'WrapAwsLambda'
 * @property {string} [from] - module specifier to import `name` from; omit if the
 *   identifier is provided some other way (e.g. a preloaded global)
 *
 * @typedef {Object} WrapEntry
 * @property {string | RegExp} match - matched against the module's absolute file path
 * @property {string} handler - the exported binding to wrap
 * @property {WrapperSpec} wrapper
 *
 * @typedef {Object} ModuleMatch
 * @property {string} name - package name, from the nearest package.json
 * @property {string} [versionRange] - semver range the package version must satisfy
 * @property {string[]} [files] - path suffixes within the package (e.g. 'dist-es/client.js');
 *   omit to match every file of the package
 *
 * @typedef {Object} PatchSpec
 * @property {string} name - exported patch function in `from`
 * @property {string} from - module specifier of the user's patch code
 *
 * @typedef {Object} PatchEntry
 * @property {ModuleMatch} module
 * @property {PatchSpec} patch
 * @property {string[]} bindings - exported names handed to the patch function
 *
 * @typedef {WrapEntry | PatchEntry} InstrumentEntry
 *
 * @typedef {Object} InstrumentConfig
 * @property {InstrumentEntry[]} entries
 */

/** Identity helper so config files get typing/autocomplete. @param {InstrumentConfig} config */
export function defineConfig(config) {
  return config
}

/** Sugar for a patches-only config. @param {PatchEntry[]} entries */
export function definePatches(entries) {
  return { entries }
}

function toPath(idOrUrl) {
  return idOrUrl.startsWith('file:') ? fileURLToPath(idOrUrl) : idOrUrl
}

function cleanPath(idOrUrl) {
  return toPath(idOrUrl)
    .replace(/[?#].*$/, '')
    .replaceAll('\\', '/')
}

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
 * @param {InstrumentConfig} config
 */
export function matchEntries(config, idOrUrl) {
  const path = cleanPath(idOrUrl)
  return config.entries.filter((entry) => entryMatches(entry, path))
}

/**
 * First matching entry — kept for callers that predate multi-entry matching.
 * @param {InstrumentConfig} config
 */
export function createMatcher(config) {
  return (idOrUrl) => matchEntries(config, idOrUrl)[0]
}

/**
 * 'cjs' or 'esm' for a module: an explicit loader-hook format wins, otherwise
 * a path heuristic (`.cjs`, `dist-cjs`) decides. Bundlers see the `module`
 * entry points, so their default is ESM.
 */
export function moduleKindFor(idOrUrl, format) {
  if (format === 'commonjs') return 'cjs'
  if (format === 'module') return 'esm'
  const path = cleanPath(idOrUrl)
  if (path.endsWith('.cjs') || path.includes('/dist-cjs/')) return 'cjs'
  return 'esm'
}

/**
 * The original wrap transform: rebind an exported const through the wrapper
 * via the native oxc transform, append the wrapper import (ESM imports are
 * hoisted, so appending keeps every existing line — and therefore the source
 * map — intact) and the double-wrap sentinel.
 *
 * @returns {{ code: string, map: string | null } | null} null when the source
 *   is already instrumented
 */
export function transformMatched(source, entry, idOrUrl) {
  if (source.includes(SENTINEL_TEXT)) {
    return null
  }
  const filename = basename(cleanPath(idOrUrl))
  const { code, map } = transformLambdaWithMapObject(source, entry.handler, entry.wrapper.name, filename)
  let finalCode = code
  if (entry.wrapper.from) {
    finalCode += `\nimport { ${entry.wrapper.name} } from ${JSON.stringify(entry.wrapper.from)};`
  }
  finalCode += `\n${SENTINEL}\n`
  return { code: finalCode, map: map ?? null }
}

/** Global registry the runtime shell preloads patch functions into. */
export const PATCH_REGISTRY = Symbol.for('wrap-esm-lambda.patches')

/** The registry key for a patch entry — must match the Rust emission exactly. */
export function patchKey(entry) {
  return `${entry.patch.from}#${entry.patch.name}`
}

/**
 * Apply every matching entry to a module, in one pass shared by both shells.
 * Wrap entries run first (they re-generate the whole module); patch entries
 * append their exports tap after, so nothing they add is disturbed. The
 * sentinel lands once at the end.
 *
 * `delivery` decides how the tap reaches the user's patch function:
 * - 'import' (build time, default): a static import is appended and the
 *   bundler resolves and bundles the patch code.
 * - 'registry' (runtime): no import is injected — the tap looks the patch up
 *   in the `PATCH_REGISTRY` global, which `registerConfig` populates before
 *   any module loads. Hook-overridden CJS sources cannot serve an injected
 *   require, so this is the only delivery that works universally at runtime.
 *
 * @param {string} source
 * @param {InstrumentEntry[]} entries
 * @param {string} idOrUrl
 * @param {{ format?: string, delivery?: 'import' | 'registry' }} [options]
 * @returns {{ code: string, map: string | null } | null} null when nothing
 *   applies or the source is already instrumented
 */
export function applyMatched(source, entries, idOrUrl, options = {}) {
  if (entries.length === 0 || source.includes(SENTINEL_TEXT)) {
    return null
  }
  const kind = moduleKindFor(idOrUrl, options.format)
  const registry = options.delivery === 'registry'
  const ordered = [...entries].sort((a, b) => (a.patch ? 1 : 0) - (b.patch ? 1 : 0))
  let code = source
  let map = null
  let aliasIndex = 0
  for (const entry of ordered) {
    if (entry.patch) {
      // Only the snippet crosses the napi boundary; for CJS not even the
      // source does (no static validation there) — round-tripping the module
      // text cost two O(n) string conversions for a few appended bytes.
      const cjs = kind === 'cjs'
      code += exportsTapSnippet(
        cjs ? '' : code,
        entry.bindings,
        entry.patch.name,
        entry.patch.from,
        cjs,
        registry,
        aliasIndex,
      )
      aliasIndex += 1
    } else {
      const filename = basename(cleanPath(idOrUrl))
      const wrapped = transformLambdaWithMapObject(code, entry.handler, entry.wrapper.name, filename)
      code = wrapped.code
      if (entry.wrapper.from) {
        code += `\nimport { ${entry.wrapper.name} } from ${JSON.stringify(entry.wrapper.from)};`
      }
      map = wrapped.map ?? null
    }
  }
  code += `\n${SENTINEL}\n`
  return { code, map }
}

/** Inline a v3 map JSON as a trailing `//# sourceMappingURL=` data URL. */
export function inlineMap(code, mapJson) {
  const base64 = Buffer.from(mapJson, 'utf8').toString('base64')
  return `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`
}
