import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig, definePatches } from '@wrap-esm-lambda/core'
import { captureThrows, captureRejects } from './helpers'

// The packaging story: instrumentation shipped as ONE installed npm package —
// patch code, config and register entry together — the way an APM vendor
// distributes it. Two pieces make it work, both covered here:
// - `definePatches(entries, import.meta.url)` resolves relative and bare
//   `from` specifiers against the config module at definition time, so the
//   package is self-contained wherever pnpm/npm places it;
// - WRAP_ESM_LAMBDA_CONFIG accepts a package specifier, resolved from the
//   app, so activation needs no config file in the app at all.
// The end-to-end legs run the real examples/function-logger* workspace
// packages through real node_modules resolution (pnpm's strict layout).

const execFileAsync = promisify(execFile)
const appDir = fileURLToPath(new URL('../examples/function-logger-app/', import.meta.url))
const loggerDir = fileURLToPath(new URL('../examples/function-logger/', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/bundle-driver.mjs', import.meta.url))

// stdout of the example app under full instrumentation — one string, shared
// by every delivery mode: vendor register, env-var package config, and the
// pre-instrumented bundle. `fetchQuote` internally calls `getQuote`; the
// rebind reaches even that intra-module call.
const EXPECTED = [
  '[fn-log] -> getQuote(1)',
  '[fn-log] <- getQuote returned "ship it"',
  '[fn-log] -> shout("ship it")',
  '[fn-log] <- shout returned "SHIP IT!"',
  'SHIP IT!',
  '[fn-log] -> fetchQuote(2)',
  '[fn-log] -> getQuote(2)',
  '[fn-log] <- getQuote returned "make it work, make it right, make it fast"',
  '[fn-log] <- fetchQuote resolved "make it work, make it right, make it fast"',
  'make it work, make it right, make it fast',
  '[fn-log] -> explode("demo")',
  '[fn-log] !! explode threw Error: quote machine broke: demo',
  'app caught: quote machine broke: demo',
].join('\n')

test('definePatches resolves relative from against the config module', () => {
  const base = import.meta.url
  const { entries } = definePatches(
    [{ module: { name: 'x' }, patch: { name: 'p', from: './fixtures/patch/patches/http-route.mjs' }, bindings: ['a'] }],
    base,
  )
  assert.strictEqual(entries[0].patch.from, fileURLToPath(new URL('./fixtures/patch/patches/http-route.mjs', base)))
  assert.ok(isAbsolute(entries[0].patch.from))
})

test('definePatches resolves a file:// URL (import.meta.resolve output) to a path', () => {
  const url = new URL('./helpers.ts', import.meta.url)
  const { entries } = definePatches([{ module: { name: 'x' }, patch: { name: 'p', from: url.href }, bindings: ['a'] }])
  assert.strictEqual(entries[0].patch.from, fileURLToPath(url))
})

test('definePatches resolves a bare package specifier from the config module', () => {
  const base = pathToFileURL(join(appDir, 'app.mjs')).href
  const { entries } = definePatches(
    [{ module: { name: 'x' }, patch: { name: 'p', from: 'example-function-logger/config' }, bindings: ['a'] }],
    base,
  )
  assert.ok(isAbsolute(entries[0].patch.from))
  assert.ok(entries[0].patch.from.endsWith(join('src', 'config.mjs')))
})

test('an unresolvable bare specifier with a base throws at definition time', () => {
  const err = captureThrows(() =>
    definePatches(
      [{ module: { name: 'x' }, patch: { name: 'p', from: 'not-an-installed-package/config' }, bindings: ['a'] }],
      import.meta.url,
    ),
  )
  assert.ok(err instanceof TypeError)
  assert.match(err.message, /does not resolve from/)
})

test('without a base, non-absolute specifiers pass through unchanged (legacy)', () => {
  const { entries } = definePatches([
    { module: { name: 'x' }, patch: { name: 'p', from: 'some-pkg/patches' }, bindings: ['a'] },
  ])
  assert.strictEqual(entries[0].patch.from, 'some-pkg/patches')
})

test('defineConfig resolves wrapper.from the same way', () => {
  const { entries } = defineConfig(
    { entries: [{ match: 'handler.mjs', handler: 'handler', wrapper: { name: 'W', from: './hooks/wrap.mjs' } }] },
    pathToFileURL(join(loggerDir, 'src', 'config.mjs')).href,
  )
  assert.strictEqual(entries[0].wrapper.from, join(loggerDir, 'src', 'hooks', 'wrap.mjs'))
})

test('one installed package delivers the whole instrumentation: --import vendor/register', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'example-function-logger/register', 'app.mjs'],
    { cwd: appDir },
  )
  assert.strictEqual(stdout.trim(), EXPECTED)
})

test('WRAP_ESM_LAMBDA_CONFIG accepts a package specifier, resolved from the app', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', 'app.mjs'], {
    cwd: appDir,
    env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: 'example-function-logger/config' },
  })
  assert.strictEqual(stdout.trim(), EXPECTED)
})

test('a config specifier that resolves nowhere fails loudly at startup', async () => {
  const err = await captureRejects<Error & { stderr: string }>(() =>
    execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', 'app.mjs'], {
      cwd: appDir,
      env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: 'not-an-installed-package/config' },
    }),
  )
  assert.match(err.stderr, /neither an existing file nor a package specifier resolvable from/)
})

test('the same packaged config serves build-time delivery: esbuild bundle, plain node', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-packaging-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await execFileAsync(process.execPath, [
      driver,
      'esbuild',
      join(appDir, 'app.mjs'),
      join(loggerDir, 'src', 'config.mjs'),
      outfile,
    ])
    // no hooks, no register entry — the instrumentation is baked in
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    assert.strictEqual(stdout.trim(), EXPECTED)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
