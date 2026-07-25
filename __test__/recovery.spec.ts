import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { captureRejects } from './helpers'

// The failure policy: what happens when instrumentation cannot do its job.
// Everything downstream of a valid config degrades — one entry, one builtin,
// one module or one patch call at a time — because a tool that sits in the
// load path of every module of a process it does not own must never be the
// reason that process dies. Every case here is also checked under
// WRAP_ESM_LAMBDA_STRICT=1, which restores the hard failure the transform
// layer raises on its own (core never recovers; the shells decide).

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))

const core = await import('@wrap-esm-lambda/core')

// the fake package has no "exports" field, so `main` (dist-cjs) is the tree
// Node actually loads: unpatched it answers 'sent:hello', patched
// 'patched:sent:hello'
const runApp = (config: string, extra: Record<string, string> = {}, app = 'app.mjs') =>
  execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', fixture(app)], {
    env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture(config), ...extra },
  })

// --- engine selection ------------------------------------------------------
// The addon is a per-platform prebuilt, so it can be missing for reasons that
// have nothing to do with the app. selectEngine is the fallback decision on
// its own, testable without breaking an installed addon.

const loaders = {
  oxc: () => Promise.reject(new Error('no prebuilt binary for this platform')),
  acorn: () => Promise.resolve({ engine: 'acorn' }),
}

test('engine selection: an unloadable default engine falls back to the pure-JS one', async () => {
  const fallbacks: unknown[] = []
  const selected = await core.selectEngine(undefined, loaders, { onFallback: (err: unknown) => fallbacks.push(err) })
  assert.strictEqual(selected.engineName, 'acorn')
  assert.strictEqual(fallbacks.length, 1, 'the fallback is reported, never silent')
  assert.match((fallbacks[0] as Error).message, /no prebuilt binary/)
})

test('engine selection: an explicitly requested engine is never substituted', async () => {
  // WRAP_ESM_LAMBDA_ENGINE=oxc means "fail if the addon is missing" — what CI
  // runs with, so a broken native build cannot pass as an acorn run
  await assert.rejects(() => core.selectEngine('oxc', loaders), /no prebuilt binary/)
})

test('engine selection: strict mode does not refuse the fallback', async () => {
  // WRAP_ESM_LAMBDA_STRICT is a policy for instrumentation failures, not a
  // statement about which engines are acceptable: wanting a moved binding to
  // throw must not cost the pure-JS engine on a platform with no addon
  process.env.WRAP_ESM_LAMBDA_STRICT = '1'
  try {
    const selected = await core.selectEngine(undefined, loaders)
    assert.strictEqual(selected.engineName, 'acorn')
  } finally {
    delete process.env.WRAP_ESM_LAMBDA_STRICT
  }
})

test('engine selection: an unknown engine name still fails loudly', async () => {
  await assert.rejects(() => core.selectEngine('esbuild', loaders), /unknown engine 'esbuild'/)
})

test('engine selection: both engines unloadable reports both causes', async () => {
  const broken = { oxc: loaders.oxc, acorn: () => Promise.reject(new Error('acorn missing too')) }
  const err = (await captureRejects(() => core.selectEngine(undefined, broken))) as Error & { cause: AggregateError }
  assert.match(err.message, /neither the 'oxc' engine nor the 'acorn' fallback/)
  assert.strictEqual(err.cause.errors.length, 2, 'both failures survive in the cause chain')
})

// --- runtime recovery ------------------------------------------------------

test('a patch module that will not import drops only its own entry', async () => {
  const { stdout, stderr } = await runApp('wrap.config.recover-missing-module.mjs')
  assert.match(stderr, /loading patch .*does-not-exist\.mjs#patchMissing.* failed/)
  assert.strictEqual(stdout.trim(), 'patched:sent:hello', 'the deliverable entry still applies')
})

test('a patch function that throws cannot break the module it patches', async () => {
  // the tap calls the patch from the patched module's own body: uncontained,
  // this is a module load failure and the app never starts
  const { stdout, stderr } = await runApp('wrap.config.recover-throwing-patch.mjs')
  assert.match(stderr, /patch code is broken/)
  assert.strictEqual(stdout.trim(), 'sent:hello', 'the module loaded, unpatched')

  const err = await captureRejects<Error & { stderr: string }>(() =>
    runApp('wrap.config.recover-throwing-patch.mjs', { WRAP_ESM_LAMBDA_STRICT: '1' }),
  )
  assert.match(err.stderr, /patch code is broken/)
})

test('a binding that moved in a dependency bump costs the patch, not the process', async () => {
  // hono's real ESM build, asked for an export it does not have: the drift
  // alarm the tap raises statically, now contained
  const config = 'wrap.config.recover-missing-binding.mjs'
  const { stdout, stderr } = await runApp(config, {}, 'app-frameworks.mjs')
  assert.match(stderr, /instrumenting file:.*hono\.js failed/)
  assert.match(stderr, /'HonoRenamedInV5' not found in module \(available: Hono\)/, 'the alarm still names both sides')
  assert.match(stdout.trim(), /hono:MISS/, 'the module loaded untouched, the app ran')

  const err = await captureRejects<Error & { stderr: string }>(() =>
    runApp(config, { WRAP_ESM_LAMBDA_STRICT: '1' }, 'app-frameworks.mjs'),
  )
  assert.match(err.stderr, /'HonoRenamedInV5' not found in module/)
})

test('build-time delivery contains a throwing patch too', async () => {
  // The runtime shell contains a throwing patch in the function it registers,
  // but a bundle has no registry: the emitted code calls the user's function
  // directly, so the containment has to be emitted with it. Same policy, same
  // strict-mode escape hatch, no runtime dependency added to the artifact.
  const { build } = await import('esbuild')
  const { unplugin } = await import('@wrap-esm-lambda/unplugin')
  const { default: config } = await import(pathToFileURL(fixture('wrap.config.recover-throwing-patch.mjs')).href)
  const outDir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-recovery-'))
  try {
    const outfile = join(outDir, 'bundle.mjs')
    await build({
      entryPoints: [fixture('app.mjs')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    const bundled = await readFile(outfile, 'utf8')
    assert.ok(bundled.includes('catch (__wel_err)'), 'the guard is baked into the artifact')

    // plain node, no hooks, no env: the patch throws and the app runs on
    const { stdout, stderr } = await execFileAsync(process.execPath, [outfile])
    assert.match(stderr, /patch code is broken/)
    assert.match(stderr, /failed, continuing without it/)
    assert.strictEqual(stdout.trim(), 'sent:hello', 'the module evaluated, unpatched')

    // and the same artifact fails loudly under strict mode
    const err = await captureRejects<Error & { stderr: string }>(() =>
      execFileAsync(process.execPath, [outfile], { env: { ...process.env, WRAP_ESM_LAMBDA_STRICT: '1' } }),
    )
    assert.match(err.stderr, /patch code is broken/)

    // '0' and 'false' are off, exactly as the runtime shell reads them
    const notStrict = await execFileAsync(process.execPath, [outfile], {
      env: { ...process.env, WRAP_ESM_LAMBDA_STRICT: '0' },
    })
    assert.strictEqual(notStrict.stdout.trim(), 'sent:hello')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('the engines report the same transform contract version core expects', async () => {
  // Core's package range cannot police this: the addon is an optional
  // dependency resolved on the consumer's machine, so a mismatch is possible
  // and worse than a missing addon — code that looks right and patches
  // nothing. Both engines answer, and core refuses an engine that disagrees.
  const oxc = await import('../index.js')
  const acorn = await import('@wrap-esm-lambda/engine-acorn')
  assert.strictEqual(oxc.tapContractVersion(), core.TAP_CONTRACT_VERSION)
  assert.strictEqual(acorn.tapContractVersion(), core.TAP_CONTRACT_VERSION)

  // an engine that loads but reports the wrong contract is rejected like one
  // that will not load at all — for the default engine, that means degrading
  const wrongContract = {
    oxc: () => Promise.resolve({ tapContractVersion: () => 999 }),
    acorn: () => Promise.resolve({ tapContractVersion: () => core.TAP_CONTRACT_VERSION }),
  }
  const verify = (engine: { tapContractVersion(): number }) => {
    if (engine.tapContractVersion() !== core.TAP_CONTRACT_VERSION) throw new Error('transform contract mismatch')
  }
  const selected = await core.selectEngine(undefined, wrongContract, { verify })
  assert.strictEqual(selected.engineName, 'acorn', 'a mismatched addon degrades to the JS engine')
  await assert.rejects(() => core.selectEngine('oxc', wrongContract, { verify }), /contract mismatch/)
})

test('recovered failures are retrievable, not just printed', async () => {
  const hooks = await import('@wrap-esm-lambda/hooks')
  const before = core.instrumentationFailures().total
  await hooks.preloadPatches({
    entries: [{ module: { name: 'x' }, patch: { name: 'nope', from: '/nonexistent/patch.mjs' }, bindings: ['a'] }],
  })
  const after = core.instrumentationFailures()
  assert.strictEqual(after.total, before + 1)
  assert.match(after.entries.at(-1)!.what, /loading patch '\/nonexistent\/patch\.mjs#nope'/)
})

// --- the kill switch -------------------------------------------------------

test('WRAP_ESM_LAMBDA_DISABLE turns the whole shell off', async () => {
  const { stdout } = await runApp('wrap.config.mjs', { WRAP_ESM_LAMBDA_DISABLE: '1' })
  assert.strictEqual(stdout.trim(), 'sent:hello', 'no hook, no patch, no transform')
})

test('WRAP_ESM_LAMBDA_DISABLE short-circuits before the config is even resolved', async () => {
  // the mitigation lever has to work when the config itself is the fault —
  // and without loading the engine at all
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: '', WRAP_ESM_LAMBDA_DISABLE: '1' } },
  )
  assert.strictEqual(stdout.trim(), 'sent:hello')
})

test('a missing config still fails loudly: there is nothing to degrade to', async () => {
  const err = await captureRejects<Error & { stderr: string }>(() =>
    execFileAsync(process.execPath, ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')], {
      env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: '' },
    }),
  )
  assert.match(err.stderr, /set WRAP_ESM_LAMBDA_CONFIG/)
})
