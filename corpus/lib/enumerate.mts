// Enumeration probe, one subprocess per corpus package (loading the package
// must not pollute the runner). Resolves the surface (lib/surface.mts) and
// times the actual transform (core's applyMatched — the same pipeline both
// shells run, star walk included) over it. Prints one JSON report on
// stdout. For the repeated-measurement engine comparison, see
// lib/bench-worker.mts.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { applyMatched, engineName, nearestPackage } from '@wrap-esm-lambda/core'
import type { InstrumentEntry } from '@wrap-esm-lambda/core'
import { resolveSurface, surfaceOptionsFromEnv } from './surface.mts'
import type { SurfaceTarget } from './surface.mts'

export interface EnumeratedTarget extends SurfaceTarget {
  transformMs: number
  tier: 'append' | 'rewrite'
  bytesIn: number
  bytesOut: number
}

export interface EnumerateReport {
  engine: string
  version: string
  targets: EnumeratedTarget[]
}

const pkg = process.env.CORPUS_PKG
const identityFrom = process.env.CORPUS_IDENTITY
if (!pkg || !identityFrom) throw new Error('CORPUS_PKG / CORPUS_IDENTITY not set')

const { requireEntry, targets } = await resolveSurface(pkg, surfaceOptionsFromEnv())

// Warm the engine (lazy bind + first-parse costs must not land in a
// package's timing) before measuring each target through the real pipeline.
{
  const warm: InstrumentEntry[] = [
    { module: { name: pkg }, patch: { name: 'identityPatch', from: identityFrom }, bindings: ['x'] },
  ]
  applyMatched('export function x() {}\n', warm, 'file:///warmup.mjs', { format: 'module', delivery: 'registry' })
}

const enumerated: EnumeratedTarget[] = targets.map((target) => {
  const source = readFileSync(target.file)
  const entries: InstrumentEntry[] = [
    {
      module: { name: pkg, files: [target.file] },
      patch: { name: 'identityPatch', from: identityFrom },
      bindings: target.bindings,
    },
  ]
  const url = pathToFileURL(target.file).href
  // min of 3: large-buffer allocation on shared runners is jittery enough
  // to swamp a single sample (see lib/bench-worker.mts for the full story)
  let applied: ReturnType<typeof applyMatched> = null
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    applied = applyMatched(source, entries, url, { format: target.format, delivery: 'registry' })
    best = Math.min(best, performance.now() - start)
  }
  if (applied === null) throw new Error(`nothing applied for ${target.file}`)
  return {
    ...target,
    transformMs: best,
    // rewrite-path output is a regenerated string with a map; the append
    // fast path returns the untouched bytes plus snippets, map-less
    tier: target.format === 'module' && applied.map != null ? 'rewrite' : 'append',
    bytesIn: source.length,
    bytesOut: Buffer.byteLength(applied.code),
  }
})

const info = nearestPackage(requireEntry)
const report: EnumerateReport = { engine: engineName(), version: info?.version ?? 'unknown', targets: enumerated }
console.log(JSON.stringify(report))
