import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// The actual instrumentation work for web frameworks: capturing the matched
// route TEMPLATE per request (OTel's http.route), the way the
// opentelemetry-js-contrib instrumentations do — express at the app-handle
// boundary, fastify via an injected onRequest hook, hono via auto-installed
// middleware — delivered as three declarative patch entries.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))
const env = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.http-route.mjs') }

test('http.route via import: all three frameworks report the template, not the URL', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-http-route.mjs')],
    { env },
  )
  // express composes the mounted router prefix; the values are templates
  // (/users/:id), never the concrete /users/42
  t.is(stdout.trim(), 'express=/api/users/:id fastify=/users/:id hono=/api/users/:id')
})

test('http.route via require: express and fastify capture; hono CJS degrades openly, app unharmed', async (t) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-http-route.cjs')],
    { env },
  )
  // the bundled-CJS hono cannot be rebound (getter-only exports), so route
  // capture is knowingly absent there — while the app keeps serving
  t.is(stdout.trim(), 'express=/api/users/:id fastify=/users/:id hono=none hono-app=works')
})
