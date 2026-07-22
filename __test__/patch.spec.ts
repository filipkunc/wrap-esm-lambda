import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { exportsTapSnippet, exportsTapSnippetFromBuffer } from '../index'

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

test('esm tap emission (import delivery): snippet only, source never round-trips', (t) => {
  const source = 'export class Client {}\nexport const VERSION = "1.0.0";\n'
  const out = exportsTapSnippet(source, ['Client', 'VERSION'], 'patchIt', '/abs/patch.ts', false, false, 0)
  t.false(out.includes('export class'), 'only the appended snippet is returned')
  t.true(out.includes('import { patchIt as __wel_patch_0 } from "/abs/patch.ts";'))
  t.true(out.includes('get Client() { return Client; }'))
  t.true(out.includes('set Client(v) { Client = v; }'))
  t.true(out.includes('get VERSION() { return VERSION; }'))
  t.false(out.includes('set VERSION'), 'const exports must not get a setter')
})

test('cjs tap emission (registry delivery): module.exports accessors, no injected require', (t) => {
  // CJS needs no static validation, so not even the source crosses napi
  const out = exportsTapSnippet('', ['Client'], 'patchIt', '/abs/patch.ts', true, true, 0)
  t.true(out.startsWith('\n'), 'append-ready snippet')
  t.false(out.includes('require('), 'hook-overridden CJS cannot serve an injected require')
  t.true(out.includes('Symbol.for("wrap-esm-lambda.patches")'))
  t.true(out.includes('["/abs/patch.ts#patchIt"]'))
  t.true(out.includes('get Client() { return module.exports.Client; }'))
})

test('buffer-input tap emission: identical to the string variant', (t) => {
  // The runtime-hook shape: source stays the UTF-8 Buffer nextLoad provided
  const source = 'export class Client {}\nexport const VERSION = "1.0.0";\n'
  const esm = exportsTapSnippetFromBuffer(Buffer.from(source), ['Client'], 'patchIt', '/abs/patch.ts', false, true, 0)
  t.deepEqual(esm, exportsTapSnippet(source, ['Client'], 'patchIt', '/abs/patch.ts', false, true, 0))

  const err = t.throws(() =>
    exportsTapSnippetFromBuffer(Buffer.from([0xff, 0xfe]), ['Client'], 'patchIt', '/abs/patch.ts', false, true, 0),
  )
  t.regex(err!.message, /not valid UTF-8/)
})

test('applyMatched buffer fast path: Buffer in, Buffer out, same bytes as the string path', (t) => {
  const clientPath = fixture('node_modules/@fake/smithy-client/dist-es/client.js')
  const entries = core.matchEntries(config, clientPath)
  t.is(entries.length, 1)
  const source = readFileSync(clientPath)

  const viaBuffer = core.applyMatched(source, entries, clientPath, { format: 'module', delivery: 'registry' })
  t.true(Buffer.isBuffer(viaBuffer.code), 'patch-only match stays in UTF-8 bytes')
  t.is(viaBuffer.map, null)

  const viaString = core.applyMatched(source.toString('utf8'), entries, clientPath, {
    format: 'module',
    delivery: 'registry',
  })
  t.deepEqual(viaBuffer.code.toString('utf8'), viaString.code, 'both paths emit identical modules')

  // the sentinel guard must work on bytes too
  t.is(core.applyMatched(viaBuffer.code, entries, clientPath, { format: 'module', delivery: 'registry' }), null)
})

test('requesting a missing export fails loudly at transform time', (t) => {
  const err = t.throws(() => exportsTapSnippet('export class Client {}\n', ['Klient'], 'p', '/p.ts', false, false, 0))
  t.regex(err!.message, /export 'Klient' not found/)
  t.regex(err!.message, /Client/, 'error lists what is available')
})

test('package matcher: name, version range and files gate the entry', (t) => {
  const clientPath = fixture('node_modules/@fake/smithy-client/dist-es/client.js')
  t.is(core.matchEntries(config, clientPath).length, 1)
  t.is(core.matchEntries(config, pathToFileURL(clientPath).href).length, 1, 'file URLs match too')
  t.is(
    core.matchEntries(config, fixture('node_modules/@fake/smithy-client/dist-es/index.js')).length,
    0,
    'files list excludes the barrel',
  )

  const wrongVersion = {
    entries: [{ ...config.entries[0], module: { ...config.entries[0].module, versionRange: '>=9' } }],
  }
  t.is(core.matchEntries(wrongVersion, clientPath).length, 0, 'version range excludes 4.2.0')
})

test('builtin patch: node:os patched at preload, seen by named import, default import and require', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-builtin.mjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.builtin.mjs') } },
  )
  t.is(stdout.trim(), 'builtin:patched-all')
})

test('builtin patch: versionRange gates on the running Node', async (t) => {
  // Same entry but a range excluding the current Node: preload must skip the
  // patch (matcher semantics), leaving the builtin untouched.
  const { default: builtinConfig } = await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)
  const gated = {
    entries: [{ ...builtinConfig.entries[0], module: { ...builtinConfig.entries[0].module, versionRange: '<20' } }],
  }
  t.is(core.builtinPatchEntries(gated).length, 0)
  t.is(core.builtinPatchEntries(builtinConfig).length, 1)
})

test('builtin patch: a missing binding fails loudly at preload', async (t) => {
  const { default: builtinConfig } = await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)
  const hooks = await import('@wrap-esm-lambda/hooks')
  const broken = {
    entries: [{ ...builtinConfig.entries[0], bindings: ['definitelyNotAnOsExport'] }],
  }
  await hooks.preloadPatches(broken)
  const err = t.throws(() => hooks.applyBuiltinPatches(broken))
  t.regex(err!.message, /'definitelyNotAnOsExport' not found in node:os/)
  t.regex(err!.message, /hostname/, 'error lists what is available')
})

test('builtin patch: never matches file paths, so the build-time shell cannot silently claim it', async (t) => {
  const { default: builtinConfig } = await import(pathToFileURL(fixture('wrap.config.builtin.mjs')).href)
  t.is(core.matchEntries(builtinConfig, fixture('node_modules/@fake/smithy-client/dist-es/client.js')).length, 0)
  t.is(core.matchEntries(builtinConfig, '/anywhere/node_modules/os/index.js').length, 0)
})

test('runtime mode: ESM import gets patched via dist-es', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env: hookEnv },
  )
  t.is(stdout.trim(), 'patched:sent:hello')
})

test('runtime mode: CJS require gets patched via dist-cjs getter-only exports', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.cjs')],
    { env: hookEnv },
  )
  t.is(stdout.trim(), 'patched:sent:hello')
})

test('build mode: esbuild bundles the patched dist-es', async (t) => {
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
    t.true(bundled.includes('patchSmithy'), 'user patch code is bundled in')

    // plain node, no hooks, no config — the patch is baked into the artifact
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    t.is(stdout.trim(), 'patched:sent:hello')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('double-patch guard: runtime hook passes through a patched bundle', async (t) => {
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
    t.is(stdout.trim(), 'patched:sent:hello', 'must stay single-patched')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('patch dependencies: relative TS helper + bare npm specifier, runtime mode', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.deps.ts') } },
  )
  t.is(stdout.trim(), 'deps:sent:hello!', 'the patch module graph resolves at preload')
})

test('patch dependencies: the same graph bundles in build mode', async (t) => {
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
    t.true(bundled.includes('exclaim'), 'the relative TS helper is bundled')

    const { stdout } = await execFileAsync(process.execPath, [outfile])
    t.is(stdout.trim(), 'deps:sent:hello!', 'chalk and the helper ride along in the artifact')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('DOCUMENTED FOOTGUN: a patch importing its own target diverges between modes', async (t) => {
  // Runtime: preloading the patch pulls the target into the module cache
  // BEFORE hooks install — the app gets the cached, unpatched module and the
  // patch silently does nothing.
  const env = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.imports-target.ts') }
  const runtime = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env },
  )
  t.is(runtime.stdout.trim(), 'sent:hello', 'runtime mode: silently UNPATCHED')

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
    t.is(built.stdout.trim(), 'never:sent:hello', 'build mode: patched — the modes DISAGREE')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
