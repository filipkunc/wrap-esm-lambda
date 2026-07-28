import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { exportsTap, exportsTapFromBuffer } from '../index.js'
import * as acornEngine from '@wrap-esm-lambda/engine-acorn'

const TAP = [{ bindings: ['Client'], patchName: 'patch', patchFrom: '/p.ts', aliasIndex: 0 }]
// @ts-expect-error untyped internal module
import { lexEsm } from 'import-in-the-middle/lib/get-esm-exports.mjs'

// The transform-latency cases, shared by `pnpm bench` (the table) and
// `pnpm bench:chart` (the charts): declarative-patch transform latency on
// the REAL instrumentation target — @smithy/core's client submodule, the
// file every @aws-sdk/client-* send() funnels through. Both tools express
// the same intent declaratively — orchestrion as a { className, methodName }
// function query rewriting the method body into tracingChannel publishes,
// the exports tap as a validated append handing the class to user code.

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

export function measureUs(fn: () => void, warmupMs = 200, measureMs = 800): number {
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

export const inputDescription =
  `input: @smithy/core@${corePkg.version}\n` +
  `  dist-es client.js: ${esmSource.length} bytes, dist-cjs index.js: ${cjsSource.length} bytes`

// Every label reads `tool: operation (input)` — the tool first (oxc and
// acorn are the two engines of THIS package, iitm and orchestrion the
// neighbors), then which of the two tiers is being measured:
// - "tap"           — the transform call alone (what src/transform.rs /
//                     engine-acorn's tap.mts cost per call);
// - "whole hook op" — everything a registerHooks load hook does per module:
//                     take nextLoad's bytes, transform, append the snippet.
//                     "decode + tap + append" is the string plumbing (Buffer
//                     -> UTF-16 -> napi); "zero-copy buffer" keeps the source
//                     in UTF-8 end to end (exportsTapFromBuffer +
//                     Buffer.concat), which is what the runtime shell ships.
// Inputs: 1.8 KB is @smithy/core's real dist-es client.js; 42 KB is the same
// file padded to its dist-cjs bundle's size.
//
// `mechanism: true` marks one representative case per tool — the same
// per-module analysis/transform on the same 1.8 KB file — for the
// apples-to-apples cross-tool chart. Everything else is engine detail
// (plumbing, tiers, input sizes) and only charts within oxc/acorn.
export const cases: { label: string; run: () => void; mechanism?: boolean }[] = [
  {
    label: 'oxc tap: ESM parse + validate (1.8 KB)',
    mechanism: true,
    run: () => exportsTap(esmSource, TAP, false, true),
  },
  {
    label: 'oxc tap: CJS snippet, no parse',
    run: () => exportsTap('', TAP, true, true),
  },
  {
    // same parse+validate, but the source crosses napi as a zero-copy Buffer
    // instead of a UTF-16 string paying an O(n) conversion
    label: 'oxc tap: ESM parse + validate, buffer in (1.8 KB)',
    run: () => exportsTapFromBuffer(esmBuffer, TAP, false, true),
  },
  {
    label: 'oxc whole hook op: decode + tap + append (1.8 KB)',
    run: () => {
      const source = esmBuffer.toString('utf8')
      void (source + exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    label: 'oxc whole hook op: zero-copy buffer (1.8 KB)',
    run: () => {
      void Buffer.concat([esmBuffer, Buffer.from(exportsTapFromBuffer(esmBuffer, TAP, false, true).snippets)])
    },
  },
  {
    label: 'oxc whole hook op: decode + tap + append (42 KB)',
    run: () => {
      const source = esmBigBuffer.toString('utf8')
      void (source + exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    label: 'oxc whole hook op: zero-copy buffer (42 KB)',
    run: () => {
      void Buffer.concat([esmBigBuffer, Buffer.from(exportsTapFromBuffer(esmBigBuffer, TAP, false, true).snippets)])
    },
  },
  {
    // the same parse+validate through the pure-JS engine: what the tap costs
    // with no Rust in the loop (acorn parse instead of oxc-across-napi)
    label: 'acorn tap: ESM parse + validate (1.8 KB)',
    mechanism: true,
    run: () => acornEngine.exportsTap(esmSource, TAP, false, true),
  },
  {
    label: 'acorn tap: CJS snippet, no parse',
    run: () => acornEngine.exportsTap('', TAP, true, true),
  },
  {
    // no zero-copy variant here: the JS engine parses in-process, so there
    // is no napi boundary for a buffer to save — decode is the only plumbing
    label: 'acorn whole hook op: decode + tap + append (1.8 KB)',
    run: () => {
      const source = esmBuffer.toString('utf8')
      void (source + acornEngine.exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    label: 'acorn whole hook op: decode + tap + append (42 KB)',
    run: () => {
      const source = esmBigBuffer.toString('utf8')
      void (source + acornEngine.exportsTap(source, TAP, false, true).snippets)
    },
  },
  {
    // iitm's per-module analysis step (es-module-lexer): the fair mechanism
    // comparison for our parse+validate. Its full per-module cost additionally
    // includes generating and evaluating a facade module per interception.
    label: 'iitm: lexEsm analysis step (1.8 KB)',
    mechanism: true,
    run: () => lexEsm(esmSource),
  },
  {
    label: 'orchestrion: Client#send body rewrite, stock (1.8 KB)',
    mechanism: true,
    run: () => orchestrion.transform(esmSource, 'esm'),
  },
  {
    label: 'orchestrion: Client#send body rewrite, cached selector (1.8 KB)',
    mechanism: true,
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
