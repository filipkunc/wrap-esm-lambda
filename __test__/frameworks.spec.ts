import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureRejects } from './helpers'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The exports tap against real framework package shapes: pure-CJS express,
// module.exports-is-the-API fastify, and the dual package hono (separate
// dist/ ESM and dist/cjs/ trees). One declarative config covers all three;
// the ESM apps consume express/fastify through the CJS-over-ESM-loader
// corridor where Module._load patching was historically unreliable.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))
const env = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.frameworks.mjs') }

test('frameworks via import: express + fastify (CJS-over-ESM) and hono (real ESM build)', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-frameworks.mjs')],
    { env },
  )
  assert.strictEqual(stdout.trim(), 'express:ok fastify:ok hono:ok')
})

test('frameworks via require: pure CJS chain, fastify factory rebound via "module.exports"', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-frameworks.cjs')],
    { env },
  )
  assert.strictEqual(stdout.trim(), 'express:ok fastify:ok hono:ok')
})

test('build mode: the same frameworks config lands through esbuild — pure-CJS express and fastify included', async () => {
  // The README quick-start claim, on the real packages: one config, both
  // shells. At build time express/fastify are classified CJS by syntax
  // detection and their patches arrive via require-delivery snippets; hono
  // rides the ESM path. Plain `node bundle.mjs` then proves the behavior.
  // @ts-expect-error untyped workspace package
  const { unplugin } = await import('@wrap-esm-lambda/unplugin')
  const { default: config } = await import(pathToFileURL(fixture('wrap.config.frameworks.mjs')).href)
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-frameworks-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('app-frameworks.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      // the CJS dependency graphs require node builtins, which esbuild's ESM
      // output serves through a createRequire shim — the standard esbuild
      // recipe for node targets, unrelated to the tap
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    assert.strictEqual(stdout.trim(), 'express:ok fastify:ok hono:ok')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('frameworks without the hook: nothing is patched (the ok signals are not ambient)', async () => {
  const { stdout } = await execFileAsync(process.execPath, [fixture('app-frameworks.mjs')])
  assert.match(stdout.trim(), /express:MISS fastify:MISS hono:MISS/)
})

test('rebinding a getter-only bundled-CJS export fails loudly, never silently', async () => {
  // hono's dist/cjs is sloppy mode with non-configurable getter exports:
  // plain assignment would no-op silently. The tap's verified setter turns
  // that into a hard error at patch time.
  const err = await captureRejects(() =>
    execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-frameworks.cjs')], {
      env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.hono-rebind-cjs.mjs') },
    }),
  )
  assert.match((err as Error & { stderr: string }).stderr, /rebinding Hono had no effect \(getter-only CJS export\)/)
})
