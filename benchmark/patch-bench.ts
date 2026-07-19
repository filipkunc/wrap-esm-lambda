import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { transformExportsTap } from '../index.js'

// Declarative-patch transform latency on the REAL instrumentation target:
// @smithy/core's client submodule, the file every @aws-sdk/client-* send()
// funnels through. Both tools express the same intent declaratively —
// orchestrion as a { className, methodName } function query rewriting the
// method body into tracingChannel publishes, the exports tap as a validated
// append handing the class to user code.

const require = createRequire(import.meta.url)
const { create } = require('@apm-js-collab/code-transformer')

const corePkg = require('@smithy/core/package.json') as { version: string }
const esmPath = require
  .resolve('@smithy/core/package.json')
  .replace(/package\.json$/, 'dist-es/submodules/client/smithy-client/client.js')
const cjsPath = require
  .resolve('@smithy/core/package.json')
  .replace(/package\.json$/, 'dist-cjs/submodules/client/index.js')
const esmSource = readFileSync(esmPath, 'utf8')
const cjsSource = readFileSync(cjsPath, 'utf8')

const orchestrionConfig = {
  channelName: 'smithy-send',
  module: { name: '@smithy/core', versionRange: '>=0', filePath: 'client.js' },
  functionQuery: { className: 'Client', methodName: 'send', kind: 'Async' as const },
}

function createOrchestrionTransformer() {
  const matcher = create([orchestrionConfig])
  return matcher.getTransformer('@smithy/core', corePkg.version, 'client.js')!
}

const orchestrion = createOrchestrionTransformer()

// The same esquery.parse memoization the transform chart's 'cached selector'
// bar uses: transformer.js recompiles the selector string on every call.
const octRequire = createRequire(require.resolve('@apm-js-collab/code-transformer'))
const esquery = octRequire('esquery') as { parse: (s: string) => unknown }
const parseCache = new Map<string, unknown>()
const originalParse = esquery.parse
const orchestrionCached = createOrchestrionTransformer()

function measureUs(fn: () => void, warmupMs = 200, measureMs = 800): number {
  let end = performance.now() + warmupMs
  while (performance.now() < end) fn()
  let iters = 0
  const start = performance.now()
  end = start + measureMs
  while (performance.now() < end) {
    fn()
    iters++
  }
  return ((performance.now() - start) / iters) * 1000
}

const cases: { label: string; run: () => void }[] = [
  {
    label: 'oxc exports tap (dist-es client.js, parse + validate)',
    run: () => transformExportsTap(esmSource, ['Client'], 'patch', '/p.ts', false, true, 0),
  },
  {
    label: 'oxc exports tap (dist-cjs index.js, append only)',
    run: () => transformExportsTap(cjsSource, ['Client'], 'patch', '/p.ts', true, true, 0),
  },
  {
    label: 'orchestrion Client#send query (stock)',
    run: () => orchestrion.transform(esmSource, 'esm'),
  },
  {
    label: 'orchestrion Client#send query (cached selector)',
    run: () => {
      esquery.parse = (selector: string) => {
        let parsed = parseCache.get(selector)
        if (parsed === undefined) {
          parsed = originalParse(selector)
          parseCache.set(selector, parsed)
        }
        return parsed
      }
      try {
        orchestrionCached.transform(esmSource, 'esm')
      } finally {
        esquery.parse = originalParse
      }
    },
  },
]

console.log(`input: @smithy/core@${corePkg.version}`)
console.log(`  dist-es client.js: ${esmSource.length} bytes, dist-cjs index.js: ${cjsSource.length} bytes\n`)
for (const { label, run } of cases) {
  const us = measureUs(run)
  console.log(`${label.padEnd(55)} ${us.toFixed(1).padStart(9)} µs`)
}
