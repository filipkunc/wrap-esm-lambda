import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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

// @ts-expect-error untyped workspace scaffold package
const core = await import('@wrap-esm-lambda/core')
// @ts-expect-error untyped workspace scaffold package
const { unplugin } = await import('@wrap-esm-lambda/unplugin')
const { default: config } = await import(pathToFileURL(fixture('wrap.config.mjs')).href)

testRuntime('runtime mode: loader hook wraps the handler at load time', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('main.mjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs') } },
  )
  t.is(stdout.trim(), 'wrapped:hi:42')
})

test('build mode: unplugin wraps the handler at bundle time', async (t) => {
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
    t.true(bundled.includes('WrapAwsLambda'))

    // plain `node bundle.mjs` — no hooks, no config: instrumentation is baked in
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    t.is(stdout.trim(), 'wrapped:hi:42')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('both modes produce identical instrumented code for the same module', async (t) => {
  const source = await readFile(fixture('handler.mjs'), 'utf8')
  const entry = core.createMatcher(config)(fixture('handler.mjs'))
  t.truthy(entry)

  // Both shells delegate to this one call — assert the invariant it provides.
  const first = core.transformMatched(source, entry, fixture('handler.mjs'))
  const second = core.transformMatched(source, entry, pathToFileURL(fixture('handler.mjs')).href)
  t.truthy(first)
  t.deepEqual(first, second)
  t.true(first!.code.includes('WrapAwsLambda('))
  t.true(first!.code.includes(core.SENTINEL))
})

test('double-wrap guard: transformMatched skips instrumented sources', async (t) => {
  const source = await readFile(fixture('handler.mjs'), 'utf8')
  const entry = core.createMatcher(config)(fixture('handler.mjs'))
  const once = core.transformMatched(source, entry, fixture('handler.mjs'))
  t.truthy(once)
  t.is(core.transformMatched(once!.code, entry, fixture('handler.mjs')), null)
})

testRuntime('double-wrap guard: runtime hook passes through a build-time instrumented bundle', async (t) => {
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
    t.is(stdout.trim(), 'wrapped:hi:42', 'must stay single-wrapped')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
