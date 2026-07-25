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
import type { InstrumentConfig, InstrumentEntry, WrapEntry } from '@wrap-esm-lambda/core'

// The hybrid setup end-to-end: the same fixture (handler + wrapper + config)
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

/** The fixture config's single entry, narrowed to the wrap entry it is. */
const wrapEntry = (entry: InstrumentEntry | undefined): WrapEntry => {
  assert.ok(entry && entry.patch === undefined, 'expected a wrap entry')
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
    assert.ok(bundled.includes('WrapAwsLambda'))

    // plain `node bundle.mjs` — no hooks, no config: instrumentation is baked in
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    assert.strictEqual(stdout.trim(), 'wrapped:hi:42')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('both modes produce identical instrumented code for the same module', async () => {
  const source = await readFile(fixture('handler.mjs'), 'utf8')
  const entry = wrapEntry(core.createMatcher(config)(fixture('handler.mjs')))

  // Both shells delegate to this one call — assert the invariant it provides.
  const first = core.transformMatched(source, entry, fixture('handler.mjs'))
  const second = core.transformMatched(source, entry, pathToFileURL(fixture('handler.mjs')).href)
  assert.ok(first)
  assert.deepStrictEqual(first, second)
  assert.ok(first!.code.includes('WrapAwsLambda('))
  assert.ok(first!.code.includes(core.SENTINEL))
})

test('wrap delivery: Node gets a file:// URL, a bundler gets the path as configured', async () => {
  // The one thing the two deliveries must NOT emit identically. Node's ESM
  // loader parses an import specifier as a URL, so an absolute Windows path
  // ('D:\\app\\wrap.mjs') reads as scheme 'd:' and throws
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — the runtime shell has to emit a file://
  // URL. Bundlers are the mirror image: they resolve absolute paths and not
  // file:// specifiers, which is also what lets a Lambda-layer path like
  // /opt/nodejs/wrap.mjs survive a build that never sees that directory.
  const source = await readFile(fixture('handler.mjs'), 'utf8')
  const entry = wrapEntry(core.createMatcher(config)(fixture('handler.mjs')))
  const wrapperFrom = entry.wrapper.from
  assert.ok(wrapperFrom)

  const runtime = core.applyMatched(source, [entry], fixture('handler.mjs'), {
    format: 'module',
    delivery: 'registry',
  })
  assert.ok(
    runtime!.code.includes(`from ${JSON.stringify(pathToFileURL(wrapperFrom).href)}`),
    `runtime delivery must import a file:// URL, got: ${runtime!.code}`,
  )

  const built = core.applyMatched(source, [entry], fixture('handler.mjs'), { format: 'module' })
  assert.ok(
    built!.code.includes(`from ${JSON.stringify(wrapperFrom)}`),
    `build delivery must keep the configured path, got: ${built!.code}`,
  )
})

test('double-wrap guard: transformMatched skips instrumented sources', async () => {
  const source = await readFile(fixture('handler.mjs'), 'utf8')
  const entry = wrapEntry(core.createMatcher(config)(fixture('handler.mjs')))
  const once = core.transformMatched(source, entry, fixture('handler.mjs'))
  assert.ok(once)
  assert.strictEqual(core.transformMatched(once.code, entry, fixture('handler.mjs')), null)
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
