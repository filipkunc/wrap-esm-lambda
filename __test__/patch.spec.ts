import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import { transformExportsTap } from '../index'

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

test('esm tap emission (import delivery): appended accessors, original source untouched', (t) => {
  const source = 'export class Client {}\nexport const VERSION = "1.0.0";\n'
  const out = transformExportsTap(source, ['Client', 'VERSION'], 'patchIt', '/abs/patch.ts', false, false, 0)
  t.true(out.startsWith(source))
  t.true(out.includes('import { patchIt as __wel_patch_0 } from "/abs/patch.ts";'))
  t.true(out.includes('get Client() { return Client; }'))
  t.true(out.includes('set Client(v) { Client = v; }'))
  t.true(out.includes('get VERSION() { return VERSION; }'))
  t.false(out.includes('set VERSION'), 'const exports must not get a setter')
})

test('cjs tap emission (registry delivery): module.exports accessors, no injected require', (t) => {
  const source = 'class Client {}\nmodule.exports.Client = Client;\n'
  const out = transformExportsTap(source, ['Client'], 'patchIt', '/abs/patch.ts', true, true, 0)
  t.true(out.startsWith(source))
  t.false(out.includes('require('), 'hook-overridden CJS cannot serve an injected require')
  t.true(out.includes('Symbol.for("wrap-esm-lambda.patches")'))
  t.true(out.includes('["/abs/patch.ts#patchIt"]'))
  t.true(out.includes('get Client() { return module.exports.Client; }'))
})

test('requesting a missing export fails loudly at transform time', (t) => {
  const err = t.throws(() => transformExportsTap('export class Client {}\n', ['Klient'], 'p', '/p.ts', false, false, 0))
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
