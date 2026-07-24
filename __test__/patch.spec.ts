import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureThrows } from './helpers'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { exportsTap, exportsTapFromBuffer } from '../index'

// Declarative patches end-to-end: one TypeScript config entry naming a
// package, a version range and the exports to hand over, plus a plain
// TypeScript patch function — applied to the same fake package (shaped like
// the real AWS SDK: ESM dist-es + bundled CJS dist-cjs with getter-only
// exports) through the runtime hook and through esbuild.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))

// @ts-expect-error untyped workspace package
const core = await import('@wrap-esm-lambda/core')
// @ts-expect-error untyped workspace package
const { unplugin } = await import('@wrap-esm-lambda/unplugin')
const { default: config } = await import(pathToFileURL(fixture('wrap.config.ts')).href)

const hookEnv = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.ts') }

const tapEntry = (bindings: string[], aliasIndex = 0) => ({
  bindings,
  patchName: 'patchIt',
  patchFrom: '/abs/patch.ts',
  aliasIndex,
})

test('esm tap, fast path (import delivery): snippet only, source never round-trips', () => {
  const source = 'export class Client {}\n'
  const out = exportsTap(source, [tapEntry(['Client'])], false, false)
  assert.strictEqual(out.code, undefined, 'a mutable binding stays on the append-only fast path')
  assert.ok(!out.snippets.includes('export class'), 'only the appended snippet is returned')
  assert.ok(out.snippets.includes('import { patchIt as __wel_patch_0 } from "/abs/patch.ts";'))
  assert.ok(out.snippets.includes('get Client() { return Client; }'))
  assert.ok(out.snippets.includes('set Client(v) { Client = v; }'))
})

test('esm tap, rewrite path: export const is demoted to let and gets a setter', () => {
  const source = 'export class Client {}\nexport const VERSION = "1.0.0";\n'
  const out = exportsTap(source, [tapEntry(['Client', 'VERSION'])], false, false, 'mod.js')
  assert.ok(out.code, 'a const binding takes the rewrite path')
  assert.ok(out.code!.includes('export let VERSION'), 'const demoted to let')
  assert.ok(out.map, 'the rewrite emits a source map')
  assert.ok(out.snippets.includes('set VERSION(v) { VERSION = v; }'), 'demoted const is rebindable')
})

test('cjs tap emission (registry delivery): module.exports accessors, no injected require', () => {
  // CJS needs no static validation, so not even the source crosses napi
  const out = exportsTap('', [tapEntry(['Client'])], true, true)
  assert.strictEqual(out.code, undefined, 'CJS never rewrites')
  assert.ok(out.snippets.startsWith('\n'), 'append-ready snippet')
  assert.ok(!out.snippets.includes('require('), 'hook-overridden CJS cannot serve an injected require')
  assert.ok(out.snippets.includes('Symbol.for("wrap-esm-lambda.patches")'))
  assert.ok(out.snippets.includes('["/abs/patch.ts#patchIt"]'))
  assert.ok(out.snippets.includes('get Client() { return module.exports.Client; }'))
})

test('cjs tap emission (import delivery): a require() IIFE, never an ESM import', () => {
  // Build-time delivery into a CJS module: an appended `import` statement
  // would flip the module's format under every bundler's syntax detection
  // and break its `module.exports`, so the patch arrives via require().
  const out = exportsTap('', [tapEntry(['json'])], true, false)
  assert.strictEqual(out.code, undefined, 'CJS never rewrites')
  assert.ok(!out.snippets.includes('import {'))
  assert.ok(out.snippets.includes('const { patchIt: __wel_patch_0 } = require("/abs/patch.ts");'))
  assert.ok(out.snippets.includes('get json() { return module.exports.json; }'))
})

test('build-time format fallback: module syntax decides when no format or telling path exists', () => {
  // The build shell passes no format and bundled packages rarely have a
  // telling extension — a pure-CJS `.js` (express's lib/express.js) and an
  // ESM `.js` with no package `"type"` (the AWS SDK's dist-es) must both
  // land on their real tap. `.js` all the way down, same path shape.
  const entries = [{ module: { name: 'fake' }, patch: { name: 'patchIt', from: '/abs/patch.ts' }, bindings: ['json'] }]
  const viaCjs = core.applyMatched('exports.json = function json() {};\n', entries, '/n/fake/lib/thing.js')
  assert.ok(viaCjs.code.includes('require("/abs/patch.ts")'), 'CJS source gets the require-delivery CJS tap')
  assert.ok(viaCjs.code.includes('module.exports.json'))

  const viaEsm = core.applyMatched('export function json() {}\n', entries, '/n/fake/lib/thing.js')
  assert.ok(
    viaEsm.code.includes('import { patchIt as __wel_patch_0 } from "/abs/patch.ts";'),
    'ESM syntax gets the ESM tap',
  )
})

test('buffer-input tap emission: identical to the string variant', () => {
  // The runtime-hook shape: source stays the UTF-8 Buffer nextLoad provided
  const source = 'export class Client {}\nexport const VERSION = "1.0.0";\n'
  const esm = exportsTapFromBuffer(Buffer.from(source), [tapEntry(['Client', 'VERSION'])], false, true, 'mod.js')
  assert.deepStrictEqual(esm, exportsTap(source, [tapEntry(['Client', 'VERSION'])], false, true, 'mod.js'))

  const err = captureThrows(() => exportsTapFromBuffer(Buffer.from([0xff, 0xfe]), [tapEntry(['Client'])], false, true))
  assert.match(err.message, /not valid UTF-8/)
})

test('applyMatched buffer fast path: Buffer in, Buffer out, same bytes as the string path', () => {
  const clientPath = fixture('node_modules/@fake/smithy-client/dist-es/client.js')
  const entries = core.matchEntries(config, clientPath)
  assert.strictEqual(entries.length, 1)
  const source = readFileSync(clientPath)

  const viaBuffer = core.applyMatched(source, entries, clientPath, { format: 'module', delivery: 'registry' })
  assert.ok(Buffer.isBuffer(viaBuffer.code), 'patch-only match stays in UTF-8 bytes')
  assert.strictEqual(viaBuffer.map, null)

  const viaString = core.applyMatched(source.toString('utf8'), entries, clientPath, {
    format: 'module',
    delivery: 'registry',
  })
  assert.deepStrictEqual(viaBuffer.code.toString('utf8'), viaString.code, 'both paths emit identical modules')

  // the sentinel guard must work on bytes too
  assert.strictEqual(
    core.applyMatched(viaBuffer.code, entries, clientPath, { format: 'module', delivery: 'registry' }),
    null,
  )
})

test('requesting a missing export fails loudly at transform time', () => {
  const err = captureThrows(() => exportsTap('export class Client {}\n', [tapEntry(['Klient'])], false, false))
  assert.match(err.message, /export 'Klient' not found/)
  assert.match(err.message, /Client/, 'error lists what is available')
})

test('package matcher: name, version range and files gate the entry', () => {
  const clientPath = fixture('node_modules/@fake/smithy-client/dist-es/client.js')
  assert.strictEqual(core.matchEntries(config, clientPath).length, 1)
  assert.strictEqual(core.matchEntries(config, pathToFileURL(clientPath).href).length, 1, 'file URLs match too')
  assert.strictEqual(
    core.matchEntries(config, fixture('node_modules/@fake/smithy-client/dist-es/index.js')).length,
    0,
    'files list excludes the barrel',
  )

  const wrongVersion = {
    entries: [{ ...config.entries[0], module: { ...config.entries[0].module, versionRange: '>=9' } }],
  }
  assert.strictEqual(core.matchEntries(wrongVersion, clientPath).length, 0, 'version range excludes 4.2.0')
})

test('builtin patch: node:os patched at preload, seen by named import, default import and require', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-builtin.mjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.builtin.mjs') } },
  )
  assert.strictEqual(stdout.trim(), 'builtin:patched-all')
})

test('builtin wrapper emission: guarded patch application over the real exports object', async () => {
  const { default: builtinConfig } = await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)
  const entry = builtinConfig.entries[0]
  const source = core.builtinWrapperSource('node:os', [entry])
  assert.ok(source.includes('process.getBuiltinModule("node:os")'), 'no builtin import — nothing to race or alias')
  assert.ok(source.includes(`import { patchOs as __wel_bp_0 } from ${JSON.stringify(entry.patch.from)};`))
  assert.ok(source.includes(JSON.stringify(core.builtinGuardKey(entry))), 'hybrid guard key baked in')
  assert.ok(source.includes('get hostname()'), 'requested binding handed over as accessors')
  assert.ok(source.includes('export default __wel_target;'))
  assert.ok(source.includes('as hostname'), 'named exports re-exported after patching')

  const err = captureThrows(() => core.builtinWrapperSource('node:os', [{ ...entry, bindings: ['notAnOsExport'] }]))
  assert.match(err.message, /'notAnOsExport' not found in node:os/, 'validation is loud at bundle time')
})

test('hybrid builtin guard: a build-time wrapper and the runtime preload patch exactly once', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-builtin-hybrid-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('app-builtin-raw.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      plugins: [unplugin.esbuild((await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)).default)],
      logLevel: 'silent',
    })
    // bundle alone: patched once
    const alone = await execFileAsync(process.execPath, [outfile])
    assert.match(alone.stdout.trim(), /^patched:/)
    assert.doesNotMatch(alone.stdout.trim(), /^patched:patched:/)

    // bundle under the runtime hook with the same config: the shared
    // globalThis guard must keep it patched exactly once, not twice
    const hybrid = await execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', outfile], {
      env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.builtin.mjs') },
    })
    assert.match(hybrid.stdout.trim(), /^patched:/)
    assert.doesNotMatch(hybrid.stdout.trim(), /^patched:patched:/)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('builtin patch: versionRange gates on the running Node', async () => {
  // Same entry but a range excluding the current Node: preload must skip the
  // patch (matcher semantics), leaving the builtin untouched.
  const { default: builtinConfig } = await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)
  const gated = {
    entries: [{ ...builtinConfig.entries[0], module: { ...builtinConfig.entries[0].module, versionRange: '<20' } }],
  }
  assert.strictEqual(core.builtinPatchEntries(gated).length, 0)
  assert.strictEqual(core.builtinPatchEntries(builtinConfig).length, 1)
})

test('builtin patch: a missing binding fails loudly at preload', async () => {
  const { default: builtinConfig } = await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)
  const hooks = await import('@wrap-esm-lambda/hooks')
  const broken = {
    entries: [{ ...builtinConfig.entries[0], bindings: ['definitelyNotAnOsExport'] }],
  }
  await hooks.preloadPatches(broken)
  const err = captureThrows(() => hooks.applyBuiltinPatches(broken))
  assert.match(err.message, /'definitelyNotAnOsExport' not found in node:os/)
  assert.match(err.message, /hostname/, 'error lists what is available')
})

test('builtin patch: never matches file paths, so the build-time shell cannot silently claim it', async () => {
  const { default: builtinConfig } = await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)
  assert.strictEqual(
    core.matchEntries(builtinConfig, fixture('node_modules/@fake/smithy-client/dist-es/client.js')).length,
    0,
  )
  assert.strictEqual(core.matchEntries(builtinConfig, '/anywhere/node_modules/os/index.js').length, 0)
})

test('runtime mode: ESM import gets patched via dist-es', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env: hookEnv },
  )
  assert.strictEqual(stdout.trim(), 'patched:sent:hello')
})

test('runtime mode: CJS require gets patched via dist-cjs getter-only exports', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.cjs')],
    { env: hookEnv },
  )
  assert.strictEqual(stdout.trim(), 'patched:sent:hello')
})

test('build mode: esbuild bundles the patched dist-es', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-patch-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('app.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      mainFields: ['module', 'main'],
      sourcemap: true,
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    const bundled = await readFile(outfile, 'utf8')
    assert.ok(bundled.includes('patchSmithy'), 'user patch code is bundled in')

    // plain node, no hooks, no config — the patch is baked into the artifact
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    assert.strictEqual(stdout.trim(), 'patched:sent:hello')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('double-patch guard: runtime hook passes through a patched bundle', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-patch-'))
  try {
    // The bundle is placed (with a matching package.json) so the package
    // matcher fires on it — the sentinel, not a match miss, must prevent the
    // second patch.
    const pkgDir = join(outDir, 'node_modules/@fake/smithy-client')
    const outfile = join(pkgDir, 'dist-es/client.js')
    await build({
      entryPoints: [fixture('app.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      mainFields: ['module', 'main'],
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@fake/smithy-client', version: '4.2.0', type: 'module' }),
    )
    const { stdout } = await execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', outfile], {
      env: hookEnv,
    })
    assert.strictEqual(stdout.trim(), 'patched:sent:hello', 'must stay single-patched')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('patch dependencies: relative TS helper + bare npm specifier, runtime mode', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.deps.ts') } },
  )
  assert.strictEqual(stdout.trim(), 'deps:sent:hello!', 'the patch module graph resolves at preload')
})

test('patch dependencies: the same graph bundles in build mode', async () => {
  const { default: depsConfig } = await import(pathToFileURL(fixture('wrap.config.deps.ts')).href)
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-deps-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('app.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      mainFields: ['module', 'main'],
      outfile,
      plugins: [unplugin.esbuild(depsConfig)],
      logLevel: 'silent',
    })
    const bundled = await readFile(outfile, 'utf8')
    assert.ok(bundled.includes('exclaim'), 'the relative TS helper is bundled')

    const { stdout } = await execFileAsync(process.execPath, [outfile])
    assert.strictEqual(stdout.trim(), 'deps:sent:hello!', 'chalk and the helper ride along in the artifact')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('DOCUMENTED FOOTGUN: a patch importing its own target diverges between modes', async () => {
  // Runtime: preloading the patch pulls the target into the module cache
  // BEFORE hooks install — the app gets the cached, unpatched module and the
  // patch silently does nothing.
  const env = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.imports-target.ts') }
  const runtime = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env },
  )
  assert.strictEqual(runtime.stdout.trim(), 'sent:hello', 'runtime mode: silently UNPATCHED')

  // Build: the same patch works — the bundler resolves the cycle through
  // hoisted imports instead of a preload cache. This mode divergence is why
  // the patch author contract forbids importing the instrumented graph.
  const { default: footgunConfig } = await import(pathToFileURL(fixture('wrap.config.imports-target.ts')).href)
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-footgun-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('app.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      mainFields: ['module', 'main'],
      outfile,
      plugins: [unplugin.esbuild(footgunConfig)],
      logLevel: 'silent',
    })
    const built = await execFileAsync(process.execPath, [outfile])
    assert.strictEqual(built.stdout.trim(), 'never:sent:hello', 'build mode: patched — the modes DISAGREE')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
