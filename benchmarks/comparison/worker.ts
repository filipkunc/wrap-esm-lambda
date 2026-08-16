import assert from 'node:assert/strict'
import { readFileSync, writeSync } from 'node:fs'
import { cpus } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Bench } from 'tinybench'

import { applyMatched } from '@wrap-esm-lambda/core'
import type { InstrumentEntry } from '@wrap-esm-lambda/core'

type Tool = 'wrap-esm-lambda' | 'orchestrion'

export interface ComparisonResult {
  tool: Tool
  operation: string
  p50Us: number
  p95Us: number
  p99Us: number
  rme: number
  samples: number
  environment: {
    node: string
    platform: string
    arch: string
    cpu: string
    wrapEsmLambda: string
    orchestrion: string
    smithyCore: string
  }
}

const require = createRequire(import.meta.url)
const tool = process.argv[2] as Tool
assert.ok(tool === 'wrap-esm-lambda' || tool === 'orchestrion', 'expected a comparison tool argument')

const smithyPackagePath = require.resolve('@smithy/core/package.json')
const smithyPackage = require('@smithy/core/package.json') as {
  version: string
}
const smithyPath = smithyPackagePath.replace(/package\.json$/, 'dist-es/submodules/client/smithy-client/client.js')
const source = readFileSync(smithyPath, 'utf8')
const filePath = 'dist-es/submodules/client/smithy-client/client.js'
const sourceUrl = pathToFileURL(smithyPath).href

const wrapEntries: InstrumentEntry[] = [
  {
    module: {
      name: '@smithy/core',
      versionRange: smithyPackage.version,
      files: [filePath],
    },
    patch: {
      name: 'patchClientSend',
      from: '/benchmarks/comparison/patch.mjs',
    },
    bindings: ['Client'],
  },
]

const { create } = require('@apm-js-collab/code-transformer') as {
  create(config: unknown[]): {
    getTransformer(
      moduleName: string,
      version: string,
      path: string,
    ):
      | {
          transform(code: string, format: string): { code: string }
        }
      | undefined
  }
}
const matcher = create([
  {
    channelName: 'smithy-send',
    module: {
      name: '@smithy/core',
      versionRange: smithyPackage.version,
      filePath,
    },
    functionQuery: { className: 'Client', methodName: 'send', kind: 'Async' },
  },
])
const orchestrionTransformer = matcher.getTransformer('@smithy/core', smithyPackage.version, filePath)
assert.ok(orchestrionTransformer, 'Orchestrion did not select the Smithy target')

function transformWithWrap(): string {
  return applyMatched(source, wrapEntries, sourceUrl, {
    delivery: 'registry',
    format: 'module',
  })!.code
}

function transformWithOrchestrion(): string {
  return orchestrionTransformer.transform(source, 'esm').code
}

const transform = tool === 'wrap-esm-lambda' ? transformWithWrap : transformWithOrchestrion
const verified = transform()
assert.notStrictEqual(verified, source, `${tool} returned the input unchanged`)
if (tool === 'wrap-esm-lambda') {
  assert.match(verified, /@wrap-esm-lambda instrumented/, 'Wrap output is missing its transform sentinel')
} else {
  assert.match(verified, /diagnostics_channel/, 'Orchestrion output is missing its channel integration')
  assert.match(verified, /smithy-send/, 'Orchestrion output is missing the configured channel')
}

let sink = 0
const duration = Number(process.env.BENCH_COMPARE_TIME_MS ?? 1_000)
assert.ok(Number.isFinite(duration) && duration > 0, 'BENCH_COMPARE_TIME_MS must be positive')
const bench = new Bench({
  time: duration,
  warmupTime: 250,
  iterations: 20,
  warmupIterations: 10,
  retainSamples: true,
})
bench.add(tool, () => {
  sink ^= transform().length
})
await bench.run()
assert.ok(Number.isInteger(sink), 'benchmark output was not consumed')

const task = bench.tasks[0]
const result = task?.result
assert.ok(result?.state === 'completed', `${tool} benchmark did not complete`)

const samples = result.latency.samples
assert.ok(samples, 'Tinybench did not retain latency samples')
const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
assert.ok(p95 !== undefined, 'Tinybench returned no p95 sample')

const rootPackage = require('../../package.json') as { version: string }
const orchestrionPackage = require('@apm-js-collab/code-transformer/package.json') as {
  version: string
}
const report: ComparisonResult = {
  tool,
  operation: `enable Client#send result interception on @smithy/core ESM (${(source.length / 1024).toFixed(1)} KB)`,
  p50Us: result.latency.p50 * 1_000,
  p95Us: p95 * 1_000,
  p99Us: result.latency.p99 * 1_000,
  rme: result.latency.rme,
  samples: result.latency.samplesCount,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    wrapEsmLambda: rootPackage.version,
    orchestrion: orchestrionPackage.version,
    smithyCore: smithyPackage.version,
  },
}

writeSync(process.stdout.fd, `${JSON.stringify(report)}\n`)
