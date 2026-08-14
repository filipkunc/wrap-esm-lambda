import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as nodeModule from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PatchEntry } from '@wrap-esm-lambda/core'

// The generic approach carrying the problem this repo started with, with no
// static knowledge at all: the handler's file and export name arrive from the
// Lambda environment (_HANDLER, LAMBDA_TASK_ROOT), the aws-lambda preset
// turns them into an ordinary path-matched patch entry at preload, and the
// exports tap does the wrapping. The end-to-end legs below load the handler
// exactly the way AWS's runtime interface client does (see ric-sim.mjs); the
// CI Lambda lane runs the same fixture through the real RIC on the real
// runtime image.

const hasRegisterHooks = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function'
const testRuntime = hasRegisterHooks ? test : test.skip

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/lambda-generic/${name}`, import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/lambda-generic', import.meta.url))

const { lambdaHandlerEntries } = await import('@wrap-esm-lambda/hooks/aws-lambda')
const core = await import('@wrap-esm-lambda/core')

const PATCH = { name: 'wrapHandler', from: fixture('patches/wrap.mjs') }

/** The RIC's lookup order over a resolved extensionless prefix. */
const candidates = (prefix: string) => ['', '.js', '.mjs', '.cjs'].map((extension) => prefix + extension)

test('preset: _HANDLER parses by the RIC rules — first dot splits, prefix is the module root', () => {
  const plain = lambdaHandlerEntries({ patch: PATCH, handler: 'index.handler', taskRoot: '/var/task' })
  assert.strictEqual(plain.length, 1)
  assert.deepStrictEqual(plain[0]!.module.path, candidates(resolve('/var/task', 'index')))
  assert.deepStrictEqual(plain[0]!.bindings, ['handler'])

  const nested = lambdaHandlerEntries({ patch: PATCH, handler: 'src/index.api.send', taskRoot: '/var/task' })
  assert.deepStrictEqual(nested[0]!.module.path, candidates(resolve('/var/task', 'src', 'index')))
  // the exported binding is the first property segment; the patch walks the rest
  assert.deepStrictEqual(nested[0]!.bindings, ['api'])
})

test('preset: malformed handler strings and a bare environment yield no entry', () => {
  assert.deepStrictEqual(lambdaHandlerEntries({ patch: PATCH, handler: 'nodot', taskRoot: '/var/task' }), [])
  assert.deepStrictEqual(lambdaHandlerEntries({ patch: PATCH, handler: '../up.handler', taskRoot: '/var/task' }), [])
  const savedHandler = process.env._HANDLER
  const savedRoot = process.env.LAMBDA_TASK_ROOT
  delete process.env._HANDLER
  delete process.env.LAMBDA_TASK_ROOT
  try {
    assert.deepStrictEqual(lambdaHandlerEntries({ patch: PATCH }), [])
  } finally {
    if (savedHandler !== undefined) process.env._HANDLER = savedHandler
    if (savedRoot !== undefined) process.env.LAMBDA_TASK_ROOT = savedRoot
  }
})

test('path matching: the derived entry matches the handler file and nothing else', () => {
  const [entry] = lambdaHandlerEntries({ patch: PATCH, handler: 'handler.handler', taskRoot: fixtureRoot })
  const config = { entries: [entry!] }
  const handlerUrl = pathToFileURL(fixture('handler.mjs')).href
  assert.strictEqual(core.matchEntries(config, handlerUrl).length, 1)
  assert.strictEqual(core.matchEntries(config, pathToFileURL(fixture('patches/wrap.mjs')).href).length, 0)
  // absolute candidates match exactly, not as suffixes of longer paths
  assert.strictEqual(core.matchEntries(config, pathToFileURL(fixture('handler-cjs/handler.js')).href).length, 0)
})

test('path matching: relative candidates match as suffixes, either slash flavor', () => {
  const entry: PatchEntry = { module: { path: ['lambda-generic\\handler.mjs'] }, patch: PATCH, bindings: ['handler'] }
  const matched = core.matchEntries({ entries: [entry] }, pathToFileURL(fixture('handler.mjs')).href)
  assert.strictEqual(matched.length, 1)
})

test('apply: the export-const handler goes through the rewrite path under a path entry', () => {
  const [entry] = lambdaHandlerEntries({ patch: PATCH, handler: 'handler.handler', taskRoot: fixtureRoot })
  const source = 'export const handler = async (event) => `hi:${event?.who ?? "lambda"}`\n'
  const applied = core.applyMatched(source, [entry!], fixture('handler.mjs'), {
    format: 'module',
    delivery: 'registry',
  })
  assert.ok(applied)
  assert.ok(applied.code.includes('export let handler'), 'const demoted so the patch can rebind')
})

test('validate: an existing path candidate is checked, a runtime-only one is skipped', async () => {
  const [entry] = lambdaHandlerEntries({ patch: PATCH, handler: 'handler.handler', taskRoot: fixtureRoot })
  const okReport = await core.validateConfig({ entries: [entry!] })
  assert.strictEqual(okReport.entries[0]!.status, 'ok')

  const drifted = lambdaHandlerEntries({ patch: PATCH, handler: 'handler.gone', taskRoot: fixtureRoot })
  const driftReport = await core.validateConfig({ entries: [drifted[0]!] })
  assert.strictEqual(driftReport.entries[0]!.status, 'error')
  assert.match(driftReport.entries[0]!.detail, /'gone' not exported/)

  const elsewhere = lambdaHandlerEntries({ patch: PATCH, handler: 'absent.handler', taskRoot: '/var/task' })
  const skippedReport = await core.validateConfig({ entries: [elsewhere[0]!] })
  assert.strictEqual(skippedReport.entries[0]!.status, 'skipped')
})

/** Run ric-sim under the runtime hook with a Lambda-shaped environment. */
async function invokeLikeTheRic(handlerString: string): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('ric-sim.mjs')],
    {
      env: {
        ...process.env,
        WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs'),
        _HANDLER: handlerString,
        LAMBDA_TASK_ROOT: fixtureRoot,
      },
    },
  )
  return stdout.trim()
}

testRuntime('end-to-end: the RIC load sequence gets a wrapped ESM export-const handler', async () => {
  assert.strictEqual(await invokeLikeTheRic('handler.handler'), 'wrapped:hi:ric')
})

testRuntime('end-to-end: a CJS handler behind a module-root prefix wraps the same way', async () => {
  assert.strictEqual(await invokeLikeTheRic('handler-cjs/handler.handler'), 'wrapped:hi:ric')
})

testRuntime('end-to-end: outside Lambda the same config is inert and the handler runs untouched', async () => {
  // _HANDLER without LAMBDA_TASK_ROOT: the sim falls back to its cwd to find
  // the handler, but the preset sees half an environment and emits no entry
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs'),
    _HANDLER: 'handler.handler',
  }
  delete env.LAMBDA_TASK_ROOT
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('ric-sim.mjs')],
    { env, cwd: fixtureRoot },
  )
  assert.strictEqual(stdout.trim(), 'hi:ric')
})
