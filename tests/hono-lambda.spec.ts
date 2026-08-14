import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as nodeModule from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The practical composition the pieces were built for: a Hono app behind
// hono/aws-lambda's handle(), instrumented from one config with zero app
// changes — the handler discovered from _HANDLER by the aws-lambda preset
// (per-invocation wall time and RSS), hono's matched route TEMPLATE captured
// by a subclass rebind, and every AWS SDK operation intercepted at
// @smithy/core's Client#send before credentials or network exist (which is
// why none of this needs a LocalStack). The spec drives the runnable example
// under examples/hono-lambda through the RIC's load sequence; the CI Lambda
// lane boots the SAME example on the real runtime image and reads billed
// milliseconds and max memory off the platform's REPORT line
// (.github/scripts/hono-lambda-rie.sh).

const hasRegisterHooks = typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function'
const testRuntime = hasRegisterHooks ? test : test.skip

const execFileAsync = promisify(execFile)
const exampleRoot = fileURLToPath(new URL('../examples/hono-lambda', import.meta.url))

testRuntime('runtime mode: the RIC load sequence gets the fully instrumented Hono handler', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', join(exampleRoot, 'invoke-local.mjs')],
    {
      cwd: exampleRoot,
      env: {
        ...process.env,
        WRAP_ESM_LAMBDA_CONFIG: join(exampleRoot, 'wrap.config.mjs'),
        _HANDLER: 'app.handler',
        LAMBDA_TASK_ROOT: exampleRoot,
      },
    },
  )
  // the app answered both API Gateway events
  assert.match(stdout, /GET \/quotes\/42 -> 200 .*Simplicity is prerequisite for reliability\./)
  assert.match(stdout, /POST \/quotes -> 201 \{"stored":"7"\}/)
  // the hono entry labeled both requests with the route template, not the URL
  assert.match(stdout, /http\.route = GET \/quotes\/:id -> 200/)
  assert.match(stdout, /http\.route = POST \/quotes -> 201/)
  // the smithy entry saw the SDK operation (and nothing reached the network)
  assert.match(stdout, /aws\.operation = PutObjectCommand/)
  // the preset-derived entry timed both invocations from inside the process
  const invocations = stdout.match(/invocation = [\d.]+ ms, rss = \d+ MB/g)
  assert.strictEqual(invocations?.length, 2)
})

testRuntime('SQS batch in, SNS publish out — the same config instruments the other handler shape', async () => {
  // _HANDLER now names consumer.handler: the preset derives a different
  // entry from the same config file, the smithy entry sees PublishCommand
  // instead of PutObjectCommand, and the hono entry simply never matches —
  // nothing about SQS or SNS is written down anywhere
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', join(exampleRoot, 'invoke-local.mjs'), 'sqs-batch'],
    {
      cwd: exampleRoot,
      env: {
        ...process.env,
        WRAP_ESM_LAMBDA_CONFIG: join(exampleRoot, 'wrap.config.mjs'),
        _HANDLER: 'consumer.handler',
        LAMBDA_TASK_ROOT: exampleRoot,
      },
    },
  )
  // both parseable records published to SNS through the intercepted SDK
  assert.strictEqual(stdout.match(/aws\.operation = PublishCommand/g)?.length, 2)
  // the malformed record went back to the platform for redrive, not to SNS
  assert.match(stdout, /SQS batch of 3 -> \{"batchItemFailures":\[\{"itemIdentifier":"broken-3"\}\]\}/)
  // the preset-derived entry timed the consumer the way it timed the app
  assert.match(stdout, /invocation = [\d.]+ ms, rss = \d+ MB/)
})

test('build mode: the same patches land through esbuild, and the bundle needs no hook at all', async () => {
  // The contrast case: wrap.config.build.mjs writes the handler entries
  // down explicitly (no Lambda environment exists on a build machine) and
  // reuses the runtime config's package entries; esbuild bakes all of it
  // into dist/. Plain node then runs the bundles — no --import, no config
  // env, no engine in the process — and the outputs match the runtime legs
  // line for line.
  await execFileAsync(process.execPath, [join(exampleRoot, 'build.mjs')], { cwd: exampleRoot, env: process.env })

  const built = (handler: string, ...events: string[]) =>
    execFileAsync(process.execPath, [join(exampleRoot, 'invoke-local.mjs'), ...events], {
      cwd: exampleRoot,
      env: { ...process.env, _HANDLER: handler, LAMBDA_TASK_ROOT: join(exampleRoot, 'dist') },
    })

  const app = await built('app.handler')
  assert.match(app.stdout, /GET \/quotes\/42 -> 200 .*Simplicity is prerequisite for reliability\./)
  assert.match(app.stdout, /http\.route = GET \/quotes\/:id -> 200/)
  assert.match(app.stdout, /aws\.operation = PutObjectCommand/)
  assert.strictEqual(app.stdout.match(/invocation = [\d.]+ ms, rss = \d+ MB/g)?.length, 2)

  const consumer = await built('consumer.handler', 'sqs-batch')
  assert.strictEqual(consumer.stdout.match(/aws\.operation = PublishCommand/g)?.length, 2)
  assert.match(consumer.stdout, /"batchItemFailures":\[\{"itemIdentifier":"broken-3"\}\]/)
})

testRuntime('outside Lambda the preset entry is inert, the package entries still apply', async () => {
  // no _HANDLER/LAMBDA_TASK_ROOT: invoke-local falls back to its defaults to
  // FIND the handler, the preset sees a bare environment and emits no entry,
  // so no invocation lines — while hono and the SDK stay instrumented
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WRAP_ESM_LAMBDA_CONFIG: join(exampleRoot, 'wrap.config.mjs'),
  }
  delete env._HANDLER
  delete env.LAMBDA_TASK_ROOT
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', join(exampleRoot, 'invoke-local.mjs')],
    { cwd: exampleRoot, env },
  )
  assert.match(stdout, /http\.route = GET \/quotes\/:id -> 200/)
  assert.match(stdout, /aws\.operation = PutObjectCommand/)
  assert.doesNotMatch(stdout, /invocation = /)
})
