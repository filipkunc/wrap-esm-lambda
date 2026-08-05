import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { InstrumentConfig, InstrumentEntry } from '@wrap-esm-lambda/core'

// The hybrid setup end-to-end: the same fixture (handler + patch + config)
// instrumented once at runtime through @wrap-esm-lambda/hooks and once at
// build time through @wrap-esm-lambda/unplugin, asserting identical behavior.

// `module.registerHooks` (synchronous loader hooks) landed in Node 22.15, so
// on older runtimes (node@20 in the CI matrix) the runtime shell cannot work
// and its end-to-end legs are skipped. The build-time shell has no such floor.
const hasRegisterHooks = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function'
const testRuntime = hasRegisterHooks ? test : test.skip

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/hybrid/${name}`, import.meta.url))

const core = await import('@wrap-esm-lambda/core')
const { unplugin } = await import('@wrap-esm-lambda/unplugin')
const { default: config } = (await import(pathToFileURL(fixture('wrap.config.mjs')).href)) as {
  default: InstrumentConfig
}

/** The fixture config's single entry. */
const theEntry = (entry: InstrumentEntry | undefined): InstrumentEntry => {
  assert.ok(entry, 'expected the config entry to match')
  return entry
}

testRuntime('runtime mode: loader hook wraps the handler at load time', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('main.mjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs') } },
  )
  assert.strictEqual(stdout.trim(), 'wrapped:hi:42')
})

test('build mode: unplugin wraps the handler at bundle time', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('main.mjs')],
      bundle: true,
      format: 'esm',
      sourcemap: true,
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    const bundled = await readFile(outfile, 'utf8')
    assert.ok(bundled.includes('wrapHandler'), 'the patch function is bundled in')

    // plain `node bundle.mjs` — no hooks, no config: instrumentation is baked in
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    assert.strictEqual(stdout.trim(), 'wrapped:hi:42')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('per delivery, the instrumented output is identical however the module is identified', async () => {
  const source = await readFile(fixture('handler.mjs'), 'utf8')
  const entry = theEntry(core.matchEntries(config, fixture('handler.mjs'))[0])

  // Both shells delegate to this one call — assert the invariant it provides:
  // a plain path and a file URL produce the same bytes.
  const first = core.applyMatched(source, [entry], fixture('handler.mjs'), { format: 'module' })
  const second = core.applyMatched(source, [entry], pathToFileURL(fixture('handler.mjs')).href, { format: 'module' })
  assert.ok(first)
  assert.deepStrictEqual(first, second)
  assert.ok(first!.code.includes('wrapHandler'))
  assert.ok(first!.code.includes(core.SENTINEL))

  // The one thing the two deliveries do NOT share: how the patch function
  // arrives. Build delivery appends an import of the patch module for the
  // bundler to resolve; registry delivery injects nothing and reads the
  // global registry the runtime shell preloads.
  const registry = core.applyMatched(source, [entry], fixture('handler.mjs'), {
    format: 'module',
    delivery: 'registry',
  })
  assert.ok(String(first!.code).includes(`import { wrapHandler as`), 'import delivery appends a static import')
  assert.ok(String(registry!.code).includes('wrap-esm-lambda.patches'), 'registry delivery reads the global registry')
  assert.ok(!String(registry!.code).includes('import { wrapHandler'), 'registry delivery injects no import')
})

test('double-wrap guard: applyMatched skips instrumented sources', async () => {
  const source = await readFile(fixture('handler.mjs'), 'utf8')
  const entry = theEntry(core.matchEntries(config, fixture('handler.mjs'))[0])
  const once = core.applyMatched(source, [entry], fixture('handler.mjs'), { format: 'module' })
  assert.ok(once)
  assert.strictEqual(core.applyMatched(String(once.code), [entry], fixture('handler.mjs'), { format: 'module' }), null)
})

testRuntime('double-wrap guard: runtime hook passes through a build-time instrumented bundle', async () => {
  // The outfile is named so the config's matcher fires on it — the guard, not
  // a match miss, is what must prevent the second wrap.
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-'))
  try {
    const outfile = join(outDir, 'hybrid', 'handler.mjs')
    await build({
      entryPoints: [fixture('main.mjs')],
      bundle: true,
      format: 'esm',
      sourcemap: true,
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    const { stdout } = await execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', outfile], {
      env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs') },
    })
    assert.strictEqual(stdout.trim(), 'wrapped:hi:42', 'must stay single-wrapped')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
