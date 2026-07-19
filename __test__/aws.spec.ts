import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The credibility capstone: one declarative entry against the REAL AWS SDK.
// Every @aws-sdk/client-* operation funnels through Client#send in
// @smithy/core's client submodule, so a single patch entry intercepts the
// whole SDK — through the runtime hook on the SDK's bundled dist-cjs, and
// through esbuild on its dist-es, with the same TypeScript patch code.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/aws/${name}`, import.meta.url))

// @ts-expect-error untyped workspace package
const { unplugin } = await import('@wrap-esm-lambda/unplugin')
const { default: config } = await import(pathToFileURL(fixture('aws.config.ts')).href)

const hookEnv = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('aws.config.ts') }

test('runtime mode: real S3Client send intercepted via @smithy/core dist-cjs', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env: hookEnv },
  )
  t.is(stdout.trim(), 'PutObjectCommand')
})

test('build mode: real S3Client send intercepted via @smithy/core dist-es', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-aws-'))
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
    // plain node, no hooks — the interception is baked into the bundle
    const { stdout } = await execFileAsync(process.execPath, [outfile])
    t.is(stdout.trim(), 'PutObjectCommand')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
