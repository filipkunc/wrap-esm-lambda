import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// iitm cannot hook a SCOPED package on Windows, so the whole comparison is
// skipped there — including the require() legs, which would otherwise pass for
// the wrong reason (iitm intercepting nothing at all looks the same as iitm
// declining to intercept require). The cause is upstream and specific: to
// recognise an import of a package's top level, iitm asks
// `baseDir.endsWith(specifier)` (index.js) — comparing a filesystem path
// against the specifier as written. For '@fake/smithy-client' that is
// '...\\node_modules\\@fake\\smithy-client'.endsWith('@fake/smithy-client'),
// false on Windows and true everywhere else. An unscoped name has no
// separator to disagree about, which is why this is invisible for 'express'.
// Not a property of the platform, and not of the mechanism being compared:
// the exports tap patches this same scoped fixture on Windows (patch.spec.ts,
// aws.spec.ts, both green there).
const onWindows = process.platform === 'win32'
const testIitm = onWindows ? test.skip : test
const testSyncIitm = supportsSyncHooks() && !onWindows ? test : test.skip

const run = async (setup: string, app: string) => {
  // --import takes a URL (or a relative/bare specifier), not an absolute path:
  // on Windows 'D:\\...' parses as a URL with scheme 'd:' and Node refuses it
  const setupUrl = pathToFileURL(fixture(setup)).href
  const { stdout } = await execFileAsync(process.execPath, ['--import', setupUrl, fixture(app)])
  return stdout.trim()
}

testIitm('off-thread iitm intercepts the ESM import path', async () => {
  assert.strictEqual(await run('iitm-setup-offthread.mjs', 'app.mjs'), 'iitm:sent:hello')
})

testIitm('off-thread iitm never sees a pure require() chain', async () => {
  assert.strictEqual(
    await run('iitm-setup-offthread.mjs', 'app.cjs'),
    'sent:hello',
    'unpatched — CJS entry bypasses the facade',
  )
})

testSyncIitm('sync iitm intercepts the ESM import path', async () => {
  assert.strictEqual(await run('iitm-setup.mjs', 'app.mjs'), 'iitm:sent:hello')
})

testSyncIitm('sync iitm still never sees a pure require() chain; the tap does', async () => {
  assert.strictEqual(await run('iitm-setup.mjs', 'app.cjs'), 'sent:hello', 'unpatched even in sync mode')

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.cjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.ts') } },
  )
  assert.strictEqual(stdout.trim(), 'patched:sent:hello', 'the exports tap patches the same require() chain')
})
