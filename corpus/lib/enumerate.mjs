// Enumeration probe, one subprocess per corpus package (loading the package
// must not pollute the runner). Resolves the surface (lib/surface.mjs) and
// times the actual transform (core's applyMatched — the same pipeline both
// shells run, star walk included) over it, once. Prints one JSON report on
// stdout. For the repeated-measurement engine comparison, see
// lib/bench-worker.mjs.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { applyMatched, engineName, nearestPackage } from '@wrap-esm-lambda/core'
import { resolveSurface, surfaceOptionsFromEnv } from './surface.mjs'

const pkg = process.env.CORPUS_PKG
const identityFrom = process.env.CORPUS_IDENTITY
if (!pkg || !identityFrom) throw new Error('CORPUS_PKG / CORPUS_IDENTITY not set')

const { requireEntry, targets } = await resolveSurface(pkg, surfaceOptionsFromEnv())

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
  // min of 3: large-buffer allocation on shared runners is jittery enough
  // to swamp a single sample (see lib/bench-worker.mjs for the full story)
  let applied = null
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    applied = applyMatched(source, entries, url, { format: target.format, delivery: 'registry' })
    best = Math.min(best, performance.now() - start)
  }
  target.transformMs = best
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
