// Enumeration probe, one subprocess per corpus package (loading the package
// must not pollute the runner). Resolves the package's entry file for both
// consumer conditions, derives the format Node would assign each entry,
// enumerates the export surface to tap, and times the actual transform
// (core's applyMatched — the same pipeline both shells run, star walk
// included) over the full surface. Prints one JSON report on stdout.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { applyMatched, engineName, nearestPackage, runtimeFormatFor } from '@wrap-esm-lambda/core'

const pkg = process.env.CORPUS_PKG
const identityFrom = process.env.CORPUS_IDENTITY
if (!pkg || !identityFrom) throw new Error('CORPUS_PKG / CORPUS_IDENTITY not set')

const require_ = createRequire(import.meta.url)

// Both consumer conditions of the exports map; identical for single-tree
// packages. require() resolution can legitimately land on an ESM file
// (require(esm) packages like chalk).
const importEntry = fileURLToPath(import.meta.resolve(pkg))
const requireEntry = require_.resolve(pkg)

// Load the package both ways to enumerate what a consumer can actually
// reach. import-first: for a dual package each tree is its own module
// instance and both get loaded here anyway.
const ns = await import(pkg)
const cjsExports = require_(pkg)

const isIdent = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)

// The tappable surface per entry file:
// - ESM entry: the namespace keys — exactly the statically visible exports
//   the tap validates against (star-forwarded names included; the star walk
//   resolves them).
// - CJS entry: the exports object's own enumerable keys; CJS bindings are
//   plain property accessors, unvalidated by design. An exports value with
//   no named properties (module.exports = fn) taps the whole slot through
//   the reserved "module.exports" binding.
// Manifest-driven trims: CORPUS_EXCLUDE drops named bindings (a name two
// `export *` sources forward from the same origin — Node links it by
// same-binding dedup, the static walk refuses it as ambiguous); see the
// manifest notes of the packages that set these.
const exclude = new Set((process.env.CORPUS_EXCLUDE ?? '').split(',').filter(Boolean))

function bindingsFor(format) {
  if (format === 'module') {
    return Object.keys(ns).filter((k) => isIdent(k) && !exclude.has(k))
  }
  const keys = Object.keys(cjsExports ?? {}).filter((k) => isIdent(k) && k !== '__esModule' && !exclude.has(k))
  return keys.length > 0 ? keys : ['module.exports']
}

// CORPUS_TARGETS=require restricts the tap to the require-condition entry —
// for packages whose import condition is a statically invisible shape
// (vue's index.mjs is one line: `export * from './index.js'`, a CJS file).
// Both consumer routes still observe the patch: the ESM wrapper loads the
// tapped CJS entry underneath.
const wanted = process.env.CORPUS_TARGETS === 'require' ? [requireEntry] : [...new Set([importEntry, requireEntry])]

const targets = wanted.map((file) => {
  const format = runtimeFormatFor(file)
  return { file, format, bindings: bindingsFor(format) }
})

// Warm the engine (lazy bind + first-parse costs must not land in a
// package's timing) before measuring each target through the real pipeline.
{
  const warm = [
    {
      module: { name: pkg },
      patch: { name: 'identityPatch', from: identityFrom },
      bindings: ['x'],
    },
  ]
  applyMatched('export function x() {}\n', warm, 'file:///warmup.mjs', { format: 'module', delivery: 'registry' })
}

for (const target of targets) {
  const source = readFileSync(target.file)
  const entries = [
    {
      module: { name: pkg, files: [target.file] },
      patch: { name: 'identityPatch', from: identityFrom },
      bindings: target.bindings,
    },
  ]
  const url = pathToFileURL(target.file).href
  const start = performance.now()
  const applied = applyMatched(source, entries, url, { format: target.format, delivery: 'registry' })
  target.transformMs = performance.now() - start
  if (applied === null) throw new Error(`nothing applied for ${target.file}`)
  // rewrite-path output is a regenerated string with a map; the append fast
  // path returns the untouched bytes plus snippets, map-less
  target.tier = target.format === 'module' && applied.map != null ? 'rewrite' : 'append'
  target.bytesIn = source.length
  target.bytesOut = Buffer.byteLength(applied.code)
}

const info = nearestPackage(requireEntry)
console.log(
  JSON.stringify({
    engine: engineName(),
    version: info?.version ?? 'unknown',
    targets,
  }),
)
