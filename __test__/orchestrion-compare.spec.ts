import test from 'ava'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as dc from 'node:diagnostics_channel'

import { exportsTap } from '../index'

// Same target, both tools: orchestrion-js's declarative function query and
// our exports tap, run over the identical @smithy/core client file the AWS
// capstone instruments — plus a behavioral side-by-side on the fixture
// package that shows the capability difference: orchestrion's output
// publishes tracingChannel events around the method (observe-only), the
// exports tap hands the user the class and lets them wrap or replace it.

const require = createRequire(import.meta.url)
const { create } = require('@apm-js-collab/code-transformer')

const smithyClientPath = require
  .resolve('@smithy/core/package.json')
  .replace(/package\.json$/, 'dist-es/submodules/client/smithy-client/client.js')
const smithyVersion = require('@smithy/core/package.json').version as string
const fixtureClientPath = fileURLToPath(
  new URL('./fixtures/patch/node_modules/@fake/smithy-client/dist-es/client.js', import.meta.url),
)

function orchestrionTransform(source: string, moduleName: string, version: string, filePath: string): string {
  const matcher = create([
    {
      channelName: 'smithy-send',
      module: { name: moduleName, versionRange: '>=0', filePath },
      functionQuery: { className: 'Client', methodName: 'send', kind: 'Async' },
    },
  ])
  const transformer = matcher.getTransformer(moduleName, version, filePath)
  return transformer.transform(source, 'esm').code
}

test('orchestrion instruments the same real @smithy/core client file', async (t) => {
  const source = await readFile(smithyClientPath, 'utf8')
  const out = orchestrionTransform(
    source,
    '@smithy/core',
    smithyVersion,
    'dist-es/submodules/client/smithy-client/client.js',
  )
  t.not(out, source, 'transform must have applied')
  t.true(out.includes('diagnostics_channel'), 'orchestrion wires diagnostics_channel')
  t.true(out.includes('smithy-send'), 'the configured channel name is in the output')
})

test('behavior: orchestrion observes events; the exports tap wraps the method', async (t) => {
  const source = await readFile(fixtureClientPath, 'utf8')

  // --- orchestrion: load its transformed module, subscribe, call send ---
  const orchestrionOut = orchestrionTransform(source, '@fake/smithy-client', '4.2.0', 'dist-es/client.js')
  const channelNames = [...orchestrionOut.matchAll(/(?:tracingChannel|channel)\(["']([^"']+)["']\)/g)].map((m) => m[1])
  t.true(channelNames.length > 0, 'transformed code names its channels')

  const events: string[] = []
  const kinds = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const
  const subscribed: string[] = []
  for (const name of channelNames) {
    const bases = name.startsWith('tracing:') ? [name] : [name, `tracing:${name}`]
    for (const base of bases) {
      for (const kind of kinds) {
        const full = `${base}:${kind}`
        dc.subscribe(full, () => events.push(kind))
        subscribed.push(full)
      }
    }
  }

  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-orch-'))
  try {
    const orchestrionFile = join(outDir, 'orchestrion-client.mjs')
    await writeFile(orchestrionFile, orchestrionOut)
    const orchestrionMod = await import(pathToFileURL(orchestrionFile).href)
    const observed = await new orchestrionMod.Client().send('hello')
    t.is(observed, 'sent:hello', 'orchestrion cannot change the result — observe-only')
    t.true(events.includes('start'), `send() published events (saw: ${events.join(',') || 'none'})`)

    // --- exports tap: registry delivery, wrap and rewrite the result ---
    const tapEntries = [{ bindings: ['Client'], patchName: 'patchIt', patchFrom: '/test/patch.ts', aliasIndex: 0 }]
    const tapped = source + exportsTap(source, tapEntries, false, true).snippets
    const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for('wrap-esm-lambda.patches')] ??=
      Object.create(null)) as Record<string, unknown>
    registry['/test/patch.ts#patchIt'] = (bindings: {
      Client: { prototype: { send(this: unknown, c: string): Promise<string> } }
    }) => {
      const orig = bindings.Client.prototype.send
      bindings.Client.prototype.send = async function (c: string) {
        return `patched:${await orig.call(this, c)}`
      }
    }
    const tappedFile = join(outDir, 'tapped-client.mjs')
    await writeFile(tappedFile, tapped)
    const tappedMod = await import(pathToFileURL(tappedFile).href)
    t.is(await new tappedMod.Client().send('hello'), 'patched:sent:hello', 'the tap wraps — result rewritten')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
