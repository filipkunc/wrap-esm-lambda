import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// The exports tap against real framework package shapes: pure-CJS express,
// module.exports-is-the-API fastify, and the dual package hono (separate
// dist/ ESM and dist/cjs/ trees). One declarative config covers all three;
// the ESM apps consume express/fastify through the CJS-over-ESM-loader
// corridor where Module._load patching was historically unreliable.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))
const env = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.frameworks.mjs') }

test('frameworks via import: express + fastify (CJS-over-ESM) and hono (real ESM build)', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-frameworks.mjs')],
    { env },
  )
  t.is(stdout.trim(), 'express:ok fastify:ok hono:ok')
})

test('frameworks via require: pure CJS chain, fastify factory rebound via "module.exports"', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-frameworks.cjs')],
    { env },
  )
  t.is(stdout.trim(), 'express:ok fastify:ok hono:ok')
})

test('frameworks without the hook: nothing is patched (the ok signals are not ambient)', async (t) => {
  const { stdout } = await execFileAsync(process.execPath, [fixture('app-frameworks.mjs')])
  t.regex(stdout.trim(), /express:MISS fastify:MISS hono:MISS/)
})

test('rebinding a getter-only bundled-CJS export fails loudly, never silently', async (t) => {
  // hono's dist/cjs is sloppy mode with non-configurable getter exports:
  // plain assignment would no-op silently. The tap's verified setter turns
  // that into a hard error at patch time.
  const err = await t.throwsAsync(() =>
    execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-frameworks.cjs')], {
      env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.hono-rebind-cjs.mjs') },
    }),
  )
  t.regex((err as Error & { stderr: string }).stderr, /rebinding Hono had no effect \(getter-only CJS export\)/)
})
