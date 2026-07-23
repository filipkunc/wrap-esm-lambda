import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The export shapes the tap's rewrite path unlocks, end-to-end: an exported
// const (the canonical Lambda handler shape), an anonymous default export,
// and a re-export barrel — each REBOUND by its patch, the operation the
// append-only tap had to refuse. Same fixture through the runtime hook and
// through esbuild.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/tap-shapes/${name}`, import.meta.url))

const EXPECTED = 'wrapped:hi:x wrapped:dflt:y patched:inner'
const hookEnv = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.shapes.mjs') }

test('runtime mode: const, anonymous default and barrel re-export all rebind', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-shapes.mjs')],
    { env: hookEnv },
  )
  t.is(stdout.trim(), EXPECTED)
})

test('build mode: the same rewrites land through esbuild', async (t) => {
  // @ts-expect-error untyped workspace package
  const { unplugin } = await import('@wrap-esm-lambda/unplugin')
  const { default: config } = await import(pathToFileURL(fixture('wrap.config.shapes.mjs')).href)
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-shapes-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('app-shapes.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    const bundled = await readFile(outfile, 'utf8')
    t.true(bundled.includes('patchConstHandler'), 'patch code is bundled in')

    // plain node, no hooks — rewrites are baked into the artifact
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    t.is(stdout.trim(), EXPECTED)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('the Lambda handler shape: a wrap-style patch entry needs no wrap entry anymore', async (t) => {
  // The original problem statement of this repo — wrap `export const
  // handler` — expressed as a plain patch entry rebinding the handler.
  // Before the rewrite path this threw "Cannot set property handler".
  // @ts-expect-error untyped workspace package
  const core = await import('@wrap-esm-lambda/core')
  const source = 'export const handler = async (event) => `hi from ${event}`\n'
  const entries = [
    {
      module: { name: '@fake/shapes', files: ['const.js'] },
      patch: { name: 'patchConstHandler', from: fixture('patches/shapes.mjs') },
      bindings: ['handler'],
    },
  ]
  const applied = core.applyMatched(source, entries, fixture('node_modules/@fake/shapes/const.js'), {
    format: 'module',
    delivery: 'registry',
  })
  t.truthy(applied)
  t.true(applied.code.includes('export let handler'), 'const demoted so the patch can rebind')
  t.truthy(applied.map, 'the rewrite carries a source map for the demotion')

  // buffer path takes the same rewrite (string out, since the module changed)
  const viaBuffer = core.applyMatched(Buffer.from(source), entries, fixture('node_modules/@fake/shapes/const.js'), {
    format: 'module',
    delivery: 'registry',
  })
  t.is(viaBuffer.code.toString(), applied.code, 'buffer and string paths emit identical modules')
})
