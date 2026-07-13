// Shared core of the hybrid instrumentation setup: one declarative config and
// one transform, consumed by both the runtime shell (@wrap-esm-lambda/hooks,
// a `registerHooks` load hook) and the build-time shell
// (@wrap-esm-lambda/unplugin, a bundler plugin). Both shells call
// `transformMatched` below, so the wrapped code is byte-identical no matter
// which mode produced it.
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { transformLambdaWithMapObject } from 'wrap-esm-lambda'

/**
 * Marker appended to every transformed module. Both shells skip sources that
 * already carry it, so running the runtime hook on top of a build-time
 * instrumented bundle never double-wraps. It is a legal comment (`/*!`) so
 * bundlers and minifiers keep it in the output by default — a regular comment
 * would be stripped and the guard lost. (Could later move into the Rust core
 * so any consumer gets it for free.)
 */
export const SENTINEL = '/*! @wrap-esm-lambda instrumented */'

/**
 * @typedef {Object} WrapperSpec
 * @property {string} name - identifier the wrapped export is called through, e.g. 'WrapAwsLambda'
 * @property {string} [from] - module specifier to import `name` from; omit if the
 *   identifier is provided some other way (e.g. a preloaded global)
 *
 * @typedef {Object} InstrumentEntry
 * @property {string | RegExp} match - matched against the module's absolute file path
 * @property {string} handler - the exported binding to wrap
 * @property {WrapperSpec} wrapper
 *
 * @typedef {Object} InstrumentConfig
 * @property {InstrumentEntry[]} entries
 */

/** Identity helper so config files get typing/autocomplete. @param {InstrumentConfig} config */
export function defineConfig(config) {
  return config
}

function toPath(idOrUrl) {
  return idOrUrl.startsWith('file:') ? fileURLToPath(idOrUrl) : idOrUrl
}

/**
 * Compile the config into a matcher usable from both shells: takes a module id
 * (bundlers) or file URL (loader hooks) and returns the matching entry or
 * undefined. Bundler ids can carry query suffixes (`?v=123` in Vite), which are
 * stripped before matching.
 *
 * @param {InstrumentConfig} config
 */
export function createMatcher(config) {
  return function match(idOrUrl) {
    const path = toPath(idOrUrl).replace(/[?#].*$/, '')
    return config.entries.find((entry) =>
      typeof entry.match === 'string' ? path.endsWith(entry.match) : entry.match.test(path),
    )
  }
}

/**
 * The single transform both modes run: wrap the handler via the native oxc
 * transform, append the wrapper import (ESM imports are hoisted, so appending
 * keeps every existing line — and therefore the source map — intact) and the
 * double-wrap sentinel.
 *
 * @param {string} source
 * @param {InstrumentEntry} entry
 * @param {string} idOrUrl - used for the source map's `sources` entry
 * @returns {{ code: string, map: string | null } | null} null when the source
 *   is already instrumented
 */
export function transformMatched(source, entry, idOrUrl) {
  if (source.includes(SENTINEL)) {
    return null
  }
  const filename = basename(toPath(idOrUrl).replace(/[?#].*$/, ''))
  const { code, map } = transformLambdaWithMapObject(source, entry.handler, entry.wrapper.name, filename)
  let finalCode = code
  if (entry.wrapper.from) {
    finalCode += `\nimport { ${entry.wrapper.name} } from ${JSON.stringify(entry.wrapper.from)};`
  }
  finalCode += `\n${SENTINEL}\n`
  return { code: finalCode, map: map ?? null }
}

/** Inline a v3 map JSON as a trailing `//# sourceMappingURL=` data URL. */
export function inlineMap(code, mapJson) {
  const base64 = Buffer.from(mapJson, 'utf8').toString('base64')
  return `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`
}
