// The tappable surface of a corpus package, shared by the enumerate probe
// and the engine bench worker: resolve the entry file for both consumer
// conditions, derive the format Node would assign each, and enumerate the
// bindings to tap.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runtimeFormatFor } from '@wrap-esm-lambda/core'

const isIdent = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)

/**
 * options.targets  'require' restricts to the require-condition entry — for
 *                  packages whose import condition is a statically invisible
 *                  shape (vue's one-liner `export * from './index.js'`, CJS).
 * options.exclude  named bindings to drop — kept for future transform
 *                  gaps a package exposes (its original user, date-fns'
 *                  same-binding star dedup, is fixed and no longer needs it).
 */
export async function resolveSurface(pkg, { targets: targetsMode, exclude: excludeList } = {}) {
  const require_ = createRequire(import.meta.url)

  // Both consumer conditions of the exports map; identical for single-tree
  // packages. require() resolution can legitimately land on an ESM file
  // (require(esm) packages like chalk).
  const importEntry = fileURLToPath(import.meta.resolve(pkg))
  const requireEntry = require_.resolve(pkg)

  // Load the package both ways to enumerate what a consumer can actually
  // reach — for a dual package each tree is its own module instance.
  const ns = await import(pkg)
  const cjsExports = require_(pkg)
  const exclude = new Set(excludeList ?? [])

  // - ESM entry: the namespace keys — exactly the statically visible
  //   exports the tap validates against (star-forwarded names included).
  // - CJS entry: the exports object's own enumerable keys; unvalidated by
  //   design. No named properties (module.exports = fn) taps the whole
  //   slot through the reserved "module.exports" binding.
  function bindingsFor(format) {
    if (format === 'module') {
      return Object.keys(ns).filter((k) => isIdent(k) && !exclude.has(k))
    }
    const keys = Object.keys(cjsExports ?? {}).filter((k) => isIdent(k) && k !== '__esModule' && !exclude.has(k))
    return keys.length > 0 ? keys : ['module.exports']
  }

  const wanted = targetsMode === 'require' ? [requireEntry] : [...new Set([importEntry, requireEntry])]
  return {
    requireEntry,
    targets: wanted.map((file) => {
      const format = runtimeFormatFor(file)
      return { file, format, bindings: bindingsFor(format) }
    }),
  }
}

/** The env-var protocol the runner/bench use to reach their subprocesses. */
export function surfaceOptionsFromEnv(env = process.env) {
  return {
    targets: env.CORPUS_TARGETS,
    exclude: (env.CORPUS_EXCLUDE ?? '').split(',').filter(Boolean),
  }
}
