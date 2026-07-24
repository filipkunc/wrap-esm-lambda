import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { exportsTap, exportsTapFromBuffer } from '../index.js'
// @ts-expect-error untyped workspace package
import * as acornEngine from '@wrap-esm-lambda/engine-acorn'

const TAP = [{ bindings: ['Client'], patchName: 'patch', patchFrom: '/p.ts', aliasIndex: 0 }]
// @ts-expect-error untyped internal module
import { lexEsm } from 'import-in-the-middle/lib/get-esm-exports.mjs'

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
// what a registerHooks load hook actually holds: the raw UTF-8 bytes
const esmBuffer = readFileSync(esmPath)
// the buffer argument's saving is proportional to module size and its fixed
// cost is not, so also measure a dist-cjs-sized module: the same ESM file
// padded with a comment block to the 42 KB of the real CJS bundle
const esmBigSource = esmSource + `\n/* ${'x'.repeat(cjsSource.length - esmSource.length - 8)} */\n`
const esmBigBuffer = Buffer.from(esmBigSource)

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
    label: 'oxc exports tap complete (dist-es, parse + validate)',
    run: () => exportsTap(esmSource, TAP, false, true),
  },
  {
    label: 'oxc exports tap (cjs snippet, no source across napi)',
    run: () => exportsTap('', TAP, true, true),
  },
  {
    // same parse+validate, but the source crosses napi as a zero-copy Buffer
    // instead of a UTF-16 string paying an O(n) conversion
    label: 'oxc exports tap complete (dist-es, buffer in)',
    run: () => exportsTapFromBuffer(esmBuffer, TAP, false, true),
  },
  {
    // the whole per-module hook operation on string plumbing: decode the
    // Buffer nextLoad provides, send the string across napi, append in JS
    label: 'hook op, strings (toString + tap + append)',
    run: () => {
      const source = esmBuffer.toString('utf8')
      void (source + exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    // the same operation with the source never leaving UTF-8
    label: 'hook op, buffer (tap + Buffer.concat)',
    run: () => {
      void Buffer.concat([esmBuffer, Buffer.from(exportsTapFromBuffer(esmBuffer, TAP, false, true).snippets)])
    },
  },
  {
    label: 'hook op, strings (dist-cjs-sized module)',
    run: () => {
      const source = esmBigBuffer.toString('utf8')
      void (source + exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    label: 'hook op, buffer (dist-cjs-sized module)',
    run: () => {
      void Buffer.concat([esmBigBuffer, Buffer.from(exportsTapFromBuffer(esmBigBuffer, TAP, false, true).snippets)])
    },
  },
  {
    // the same parse+validate through the pure-JS engine: what the tap costs
    // with no Rust in the loop (acorn parse instead of oxc-across-napi)
    label: 'acorn exports tap complete (dist-es, parse + validate)',
    run: () => acornEngine.exportsTap(esmSource, TAP, false, true),
  },
  {
    label: 'acorn exports tap (cjs snippet, pure JS)',
    run: () => acornEngine.exportsTap('', TAP, true, true),
  },
  {
    // the whole per-module hook operation, JS-only: decode + parse + append
    label: 'acorn hook op, strings (toString + tap + append)',
    run: () => {
      const source = esmBuffer.toString('utf8')
      void (source + acornEngine.exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    label: 'acorn hook op, strings (dist-cjs-sized module)',
    run: () => {
      const source = esmBigBuffer.toString('utf8')
      void (source + acornEngine.exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    // iitm's per-module analysis step (es-module-lexer): the fair mechanism
    // comparison for our parse+validate. Its full per-module cost additionally
    // includes generating and evaluating a facade module per interception.
    label: 'iitm lexEsm scan step only (es-module-lexer)',
    run: () => lexEsm(esmSource),
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

// --- cold start: what each hooking mechanism adds to a whole process ---

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`../__test__/fixtures/patch/${name}`, import.meta.url))

async function medianSpawnMs(args: string[], env: NodeJS.ProcessEnv, expect: string): Promise<string> {
  const times: number[] = []
  for (let i = 0; i < 9; i++) {
    const start = performance.now()
    try {
      const { stdout } = await execFileAsync(process.execPath, args, { env })
      if (stdout.trim() !== expect) return `n/a (got '${stdout.trim()}')`
    } catch (err) {
      return `n/a (${(err as Error).message.split('\n')[1] ?? 'failed'})`
    }
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return `${times[Math.floor(times.length / 2)].toFixed(1)} ms`
}

const hookEnv = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.ts') }
const hookEnvMjs = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs') }
const coldStarts: [string, string[], NodeJS.ProcessEnv, string][] = [
  ['baseline (no instrumentation)', [fixture('app.mjs')], process.env, 'sent:hello'],
  [
    'exports tap runtime hook (.ts config)',
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    hookEnv,
    'patched:sent:hello',
  ],
  [
    'exports tap runtime hook (.mjs config)',
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    hookEnvMjs,
    'patched:sent:hello',
  ],
  [
    'exports tap runtime hook (acorn engine, .mjs config)',
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { ...hookEnvMjs, WRAP_ESM_LAMBDA_ENGINE: 'acorn' },
    'patched:sent:hello',
  ],
  [
    'iitm sync (registerHooks)',
    ['--import', fixture('iitm-setup.mjs'), fixture('app.mjs')],
    process.env,
    'iitm:sent:hello',
  ],
  [
    'iitm off-thread (module.register)',
    ['--import', fixture('iitm-setup-offthread.mjs'), fixture('app.mjs')],
    process.env,
    'iitm:sent:hello',
  ],
]

console.log(`\ncold start (median of 9 runs, node ${process.version}):`)
for (const [label, args, env, expect] of coldStarts) {
  console.log(`${label.padEnd(55)} ${(await medianSpawnMs(args, env, expect)).padStart(12)}`)
}
