import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The pure-JS engine end-to-end: the same fixtures the oxc-backed suites run
// (hybrid wrap, tap shapes), driven with WRAP_ESM_LAMBDA_ENGINE=acorn — the
// JS-only deployment story, no native addon in the loop. Engine selection
// binds when core loads, so every leg runs in a child process carrying the
// env var; the build leg spawns a small esbuild driver for the same reason.

const hasRegisterHooks = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function'
const testRuntime = hasRegisterHooks ? test : test.skip

const execFileAsync = promisify(execFile)
const fixture = (dir: string, name: string) => fileURLToPath(new URL(`./fixtures/${dir}/${name}`, import.meta.url))
const acornEnv = (extra: Record<string, string>) => ({ ...process.env, WRAP_ESM_LAMBDA_ENGINE: 'acorn', ...extra })

const SHAPES_EXPECTED = 'wrapped:hi:x wrapped:hi:n wrapped:dflt:y patched:inner wrapped:greet ns:inner star:inner'

testRuntime('acorn engine, runtime mode: the hybrid wrap fixture behaves identically', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('hybrid', 'main.mjs')],
    { env: acornEnv({ WRAP_ESM_LAMBDA_CONFIG: fixture('hybrid', 'wrap.config.mjs') }) },
  )
  t.is(stdout.trim(), 'wrapped:hi:42')
})

testRuntime('acorn engine, runtime mode: every tap rewrite shape rebinds', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('tap-shapes', 'app-shapes.mjs')],
    { env: acornEnv({ WRAP_ESM_LAMBDA_CONFIG: fixture('tap-shapes', 'wrap.config.shapes.mjs') }) },
  )
  t.is(stdout.trim(), SHAPES_EXPECTED)
})

test('acorn engine, build mode: the same rewrites land through esbuild', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-acorn-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    // esbuild runs in a child so the plugin's core import binds to acorn
    const driver = `
      import { build } from 'esbuild'
      import { pathToFileURL } from 'node:url'
      // under -e the script occupies no argv slot; take the trailing args
      const [entry, configPath, outfile] = process.argv.filter((a) => a !== '--').slice(-3)
      const { unplugin } = await import('@wrap-esm-lambda/unplugin')
      const { default: config } = await import(pathToFileURL(configPath).href)
      const { engineName } = await import('@wrap-esm-lambda/core')
      if (engineName !== 'acorn') throw new Error('expected the acorn engine, got ' + engineName)
      await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile,
        plugins: [unplugin.esbuild(config)],
        logLevel: 'silent',
      })
    `
    await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        driver,
        '--',
        fixture('tap-shapes', 'app-shapes.mjs'),
        fixture('tap-shapes', 'wrap.config.shapes.mjs'),
        outfile,
      ],
      { env: acornEnv({}) },
    )
    const bundled = await readFile(outfile, 'utf8')
    t.true(bundled.includes('patchConstHandler'), 'patch code is bundled in')

    // plain node, no hooks, no env — rewrites are baked into the artifact
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    t.is(stdout.trim(), SHAPES_EXPECTED)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('an unknown engine name fails loudly at load', async (t) => {
  await t.throwsAsync(
    execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', fixture('hybrid', 'main.mjs')], {
      env: {
        ...process.env,
        WRAP_ESM_LAMBDA_ENGINE: 'esbuild',
        WRAP_ESM_LAMBDA_CONFIG: fixture('hybrid', 'wrap.config.mjs'),
      },
    }),
    { message: /unknown engine 'esbuild'/ },
  )
})
