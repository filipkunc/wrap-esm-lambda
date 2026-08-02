// One engine × one package benchmark cell, in its own process: the engine
// binds process-wide on first use, so comparing engines means one process
// per engine — the parent sets WRAP_ESM_LAMBDA_ENGINE and this worker only
// verifies it got what was asked for.
//
// Measures repeated applyMatched runs over the package's full surface (the
// real pipeline, star walk and fs reads included), reports the median, and
// a sha256 of the instrumented output so the parent can assert the engines
// produced byte-identical results.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { applyMatched, engineName, nearestPackage } from '@wrap-esm-lambda/core'
import { resolveSurface, surfaceOptionsFromEnv } from './surface.mjs'

const pkg = process.env.CORPUS_PKG
const identityFrom = process.env.CORPUS_IDENTITY
if (!pkg || !identityFrom) throw new Error('CORPUS_PKG / CORPUS_IDENTITY not set')

// per-target time budget and iteration bounds: enough repeats for a stable
// MINIMUM on small files without letting the big ones (typescript, the
// date-fns star walk) run for minutes. Min, not median: the work is
// deterministic and CPU-bound, and large-buffer allocation on shared
// runners is jittery enough (a Buffer.concat of typescript's 8.8MB source
// was observed anywhere between 2ms and 578ms in one loop) that a median
// of few samples lands wherever the jitter says — the minimum is the cost.
const BUDGET_MS = Number(process.env.CORPUS_BENCH_BUDGET_MS ?? 1200)
const MIN_ITERS = 7
const MAX_ITERS = Number(process.env.CORPUS_BENCH_MAX_ITERS ?? 50)

const { requireEntry, targets } = await resolveSurface(pkg, surfaceOptionsFromEnv())

// warm: engine bind + first parse never land in a measurement
applyMatched(
  'export function x() {}\n',
  [{ module: { name: pkg }, patch: { name: 'identityPatch', from: identityFrom }, bindings: ['x'] }],
  'file:///warmup.mjs',
  { format: 'module', delivery: 'registry' },
)

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
  const opts = { format: target.format, delivery: 'registry' }

  const times = []
  let applied
  const benchStart = performance.now()
  while (times.length < MIN_ITERS || (times.length < MAX_ITERS && performance.now() - benchStart < BUDGET_MS)) {
    const start = performance.now()
    applied = applyMatched(source, entries, url, opts)
    times.push(performance.now() - start)
  }
  if (applied === null) throw new Error(`nothing applied for ${target.file}`)

  times.sort((a, b) => a - b)
  target.minMs = times[0]
  target.iterations = times.length
  target.tier = target.format === 'module' && applied.map != null ? 'rewrite' : 'append'
  target.bytesIn = source.length
  // the byte-parity contract covers the CODE; maps legitimately differ
  // (oxc codegen maps per statement, acorn/magic-string per token — both
  // valid), so they are compared separately and reported, never asserted
  target.hash = createHash('sha256').update(applied.code).digest('hex')
  target.mapHash = applied.map == null ? null : createHash('sha256').update(applied.map).digest('hex')
}

const info = nearestPackage(requireEntry)
console.log(
  JSON.stringify({
    engine: engineName(),
    version: info?.version ?? 'unknown',
    targets,
  }),
)
