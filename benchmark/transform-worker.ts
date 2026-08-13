import { readFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Bench } from 'tinybench'

import { applyMatched, engineName } from '@wrap-esm-lambda/core'
import type { ApplyOptions, InstrumentEntry, Source } from '@wrap-esm-lambda/core'

export interface TransformResult {
  engine: string
  operation: string
  p50Us: number
  p99Us: number
  rme: number
  samples: number
}

interface TransformCase {
  operation: string
  source: Source
  entries: InstrumentEntry[]
  url: string
  options: ApplyOptions
}

const require = createRequire(import.meta.url)
const smithyPackage = require.resolve('@smithy/core/package.json')
const smithyEsmPath = smithyPackage.replace(/package\.json$/, 'dist-es/submodules/client/smithy-client/client.js')
const smithyCjsPath = smithyPackage.replace(/package\.json$/, 'dist-cjs/submodules/client/index.js')
const smithyEsm = readFileSync(smithyEsmPath)
const smithyCjs = readFileSync(smithyCjsPath)
const honoPath = fileURLToPath(new URL('./context.js', import.meta.resolve('hono/request')))
const hono = readFileSync(honoPath)

const entry = (bindings: string[]): InstrumentEntry => ({
  module: { name: 'benchmark-target' },
  patch: { name: 'patch', from: '/benchmark/patch.mjs' },
  bindings,
})

const tsSource = Buffer.from(
  Array.from({ length: 300 }, (_, i) => `interface Shape${i} { value: number; next?: Shape${i + 1} }`).join('\n') +
    '\nexport const Client: { new(): object } = class Client {}\n',
)
const tsUpstreamMap = JSON.stringify({
  version: 3,
  sources: ['generated-schema.ts'],
  sourcesContent: [tsSource.toString('utf8')],
  names: [],
  mappings: 'AAAA',
})

const runtime = { delivery: 'registry' as const }
const cases: TransformCase[] = [
  {
    operation: `ESM append · Smithy Client (${(smithyEsm.length / 1024).toFixed(1)} KB)`,
    source: smithyEsm,
    entries: [entry(['Client'])],
    url: pathToFileURL(smithyEsmPath).href,
    options: { ...runtime, format: 'module' },
  },
  {
    operation: `CJS wrap · Smithy client (${(smithyCjs.length / 1024).toFixed(1)} KB)`,
    source: smithyCjs,
    entries: [entry(['Client'])],
    url: pathToFileURL(smithyCjsPath).href,
    options: { ...runtime, format: 'commonjs' },
  },
  {
    operation: `ESM append · Hono Context (${(hono.length / 1024).toFixed(1)} KB)`,
    source: hono,
    entries: [entry(['Context'])],
    url: pathToFileURL(honoPath).href,
    options: { ...runtime, format: 'module' },
  },
  {
    operation: `TypeScript rewrite + map (${Math.round(tsSource.length / 1024)} KB)`,
    source: tsSource,
    entries: [entry(['Client'])],
    url: 'file:///benchmark/schema.ts',
    options: { ...runtime, format: 'module', upstreamMap: tsUpstreamMap },
  },
]

const selected = engineName()
const requested = process.env.WRAP_ESM_LAMBDA_ENGINE
if (requested !== selected) throw new Error(`requested engine '${requested}', bound '${selected}'`)

const bench = new Bench({ time: 500, warmupTime: 100, iterations: 10, warmupIterations: 5 })
for (const item of cases) {
  if (applyMatched(item.source, item.entries, item.url, item.options) === null) {
    throw new Error(`benchmark case did not apply: ${item.operation}`)
  }
  bench.add(item.operation, () => {
    void applyMatched(item.source, item.entries, item.url, item.options)
  })
}
await bench.run()

const results: TransformResult[] = bench.tasks.map((task) => {
  const result = task.result
  if (result.state !== 'completed') {
    throw result.state === 'errored' ? result.error : new Error(`${task.name}: benchmark ${result.state}`)
  }
  return {
    engine: selected,
    operation: task.name,
    p50Us: result.latency.p50 * 1000,
    p99Us: result.latency.p99 * 1000,
    rme: result.latency.rme,
    samples: result.latency.samplesCount,
  }
})

writeSync(process.stdout.fd, `${JSON.stringify(results)}\n`)
