import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// Reach comparison against import-in-the-middle (the loader-proxy mechanism
// OTel/dd-trace use for ESM today), on the same fixture package the exports
// tap patches. Empirical result this spec pins down: iitm intercepts modules
// entering through the ESM loader — in both its off-thread (module.register)
// and synchronous (module.registerHooks) modes — but a pure require() chain
// from a CJS entry never gets its facade, in either mode. The exports tap
// patches both paths (see patch.spec.ts), because it rewrites the source
// rather than proxying the loader.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))

// @ts-expect-error untyped ESM module
const { supportsSyncHooks } = await import('import-in-the-middle/supports-sync-hooks.mjs')
const testSyncIitm = supportsSyncHooks() ? test : test.skip

const run = async (setup: string, app: string) => {
  const { stdout } = await execFileAsync(process.execPath, ['--import', fixture(setup), fixture(app)])
  return stdout.trim()
}

test('off-thread iitm intercepts the ESM import path', async (t) => {
  t.is(await run('iitm-setup-offthread.mjs', 'app.mjs'), 'iitm:sent:hello')
})

test('off-thread iitm never sees a pure require() chain', async (t) => {
  t.is(await run('iitm-setup-offthread.mjs', 'app.cjs'), 'sent:hello', 'unpatched — CJS entry bypasses the facade')
})

testSyncIitm('sync iitm intercepts the ESM import path', async (t) => {
  t.is(await run('iitm-setup.mjs', 'app.mjs'), 'iitm:sent:hello')
})

testSyncIitm('sync iitm still never sees a pure require() chain; the tap does', async (t) => {
  t.is(await run('iitm-setup.mjs', 'app.cjs'), 'sent:hello', 'unpatched even in sync mode')

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.cjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.ts') } },
  )
  t.is(stdout.trim(), 'patched:sent:hello', 'the exports tap patches the same require() chain')
})
