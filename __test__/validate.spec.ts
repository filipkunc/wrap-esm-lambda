import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

// `wrap-esm-lambda-validate`: the counterweight to the runtime shell's
// fail-soft policy. Degrading quietly is right when the alternative is an
// outage, but it moves the cost onto whoever eventually notices the telemetry
// is thin — so every question the tap asks at load time gets asked here, ahead
// of time, against the installed tree, where failing is cheap. Exit 1 on any
// error is what makes it a CI gate.
//
// The line these tests pin: it claims exactly what static analysis can claim.
// ESM exports are visible in source, so drift is caught. CJS exports are
// assembled at runtime — the reason the CJS tap validates nothing and reaches
// through `module.exports` — so those entries report unverifiable, never
// "fine".

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/patch/', import.meta.url))
const cli = fileURLToPath(new URL('../packages/core/dist/cli.mjs', import.meta.url))

import type { InstrumentConfig, InstrumentEntry, PatchEntry, ValidationReport } from '@wrap-esm-lambda/core'

const core = await import('@wrap-esm-lambda/core')

const loadConfig = async (name: string) =>
  ((await import(pathToFileURL(fixture(name)).href)) as { default: InstrumentConfig }).default

const validate = (name: string) => loadConfig(name).then((config) => core.validateConfig(config, { cwd: fixtureDir }))

/** A config's first entry, narrowed to the patch entry these tests vary. */
const patchEntry = (entry: InstrumentEntry | undefined): PatchEntry => {
  assert.ok(entry?.patch, 'expected a patch entry')
  return entry
}

test('a config that matches the installed tree validates clean', async () => {
  const report = await validate('wrap.config.mjs')
  assert.ok(report.ok)
  assert.deepStrictEqual(report.counts, { ok: 1, skipped: 0, error: 0 })
  assert.match(report.entries[0]!.detail, /installed 4\.2\.0/, 'the installed version is part of the answer')
})

test('a binding that moved is an error, naming what the module does export', async () => {
  const report = await validate('wrap.config.recover-missing-binding.mjs')
  assert.strictEqual(report.ok, false)
  assert.strictEqual(report.counts.error, 1)
  assert.match(report.entries[0]!.detail, /'HonoRenamedInV5' not exported \(available: Hono\)/)
})

test('a version range that excludes the installed package is skipped, not failed', async () => {
  // the config is doing its job: this entry is gated off here
  const config = await loadConfig('wrap.config.mjs')
  const gated = {
    entries: [
      { ...patchEntry(config.entries[0]), module: { ...patchEntry(config.entries[0]).module, versionRange: '>=9' } },
    ],
  }
  const report = await core.validateConfig(gated, { cwd: fixtureDir })
  assert.ok(report.ok, 'a gated entry is not a failure')
  assert.strictEqual(report.counts.skipped, 1)
  assert.match(report.entries[0]!.detail, /installed 4\.2\.0 does not satisfy >=9/)
  assert.match(report.entries[0]!.detail, /will not apply/)
})

test('an uninstalled package is an error', async () => {
  const config = await loadConfig('wrap.config.mjs')
  const missing = {
    entries: [
      {
        ...patchEntry(config.entries[0]),
        module: { ...patchEntry(config.entries[0]).module, name: '@fake/not-installed' },
      },
    ],
  }
  const report = await core.validateConfig(missing, { cwd: fixtureDir })
  assert.strictEqual(report.ok, false)
  assert.match(report.entries[0]!.detail, /not installed/)
})

test('a declared file the package does not have is an error', async () => {
  const config = await loadConfig('wrap.config.mjs')
  const wrongFile = {
    entries: [
      {
        ...patchEntry(config.entries[0]),
        module: { ...patchEntry(config.entries[0]).module, files: ['dist-es/moved-in-v5.js'] },
      },
    ],
  }
  const report = await core.validateConfig(wrongFile, { cwd: fixtureDir })
  assert.strictEqual(report.ok, false)
  assert.match(report.entries[0]!.detail, /declared file is not in the installed package/)
})

test('a patch module that will not import is an error before any target is read', async () => {
  const report = await validate('wrap.config.recover-missing-module.mjs')
  assert.strictEqual(report.ok, false)
  assert.match(report.entries[0]!.detail, /patch module will not import/)
})

test('CJS targets report unverifiable rather than passing', async () => {
  // express and fastify are pure CJS: nothing about their exports is knowable
  // ahead of time, and saying "ok" would be a claim this cannot support
  const report = await validate('wrap.config.frameworks.mjs')
  assert.ok(report.ok, 'unverifiable is not failure')
  const express = report.entries.find((entry) => entry.label.startsWith('express'))
  assert.strictEqual(express?.status, 'skipped')
  assert.match(express.detail, /CommonJS: exports are assembled at runtime/)
  const hono = report.entries.find((entry) => entry.label.startsWith('hono'))
  assert.strictEqual(hono?.status, 'ok', "hono's ESM build is checkable, and checked")
})

test('builtin entries check the running Node, bindings and version gate', async () => {
  const report = await validate('wrap.config.builtin.mjs')
  assert.ok(report.ok)
  assert.match(report.entries[0]!.detail, /builtin exports hostname/)

  const config = await loadConfig('wrap.config.builtin.mjs')
  const broken = { entries: [{ ...patchEntry(config.entries[0]), bindings: ['definitelyNotAnOsExport'] }] }
  const brokenReport = await core.validateConfig(broken, { cwd: fixtureDir })
  assert.strictEqual(brokenReport.ok, false)
  assert.match(brokenReport.entries[0]!.detail, /'definitelyNotAnOsExport' not found in node:os/)
})

test('the CLI exits 1 on drift, 0 when clean, 2 when it could not even look', async () => {
  const clean = await execFileAsync(process.execPath, [cli, fixture('wrap.config.mjs')], { cwd: fixtureDir })
  assert.match(clean.stdout, /0 errors, 0 skipped, 1 ok/)

  const drifted = await execFileAsync(process.execPath, [cli, fixture('wrap.config.recover-missing-binding.mjs')], {
    cwd: fixtureDir,
  }).catch((err: Error & { code: number; stdout: string }) => err)
  assert.strictEqual((drifted as { code: number }).code, 1, 'drift exits 1 — the CI gate')
  assert.match((drifted as { stdout: string }).stdout, /1 error, 0 skipped, 0 ok/)

  // nothing validated is a different outcome from validated-and-broken
  const unreadable = await execFileAsync(process.execPath, [cli, './no-such-config.mjs'], { cwd: fixtureDir }).catch(
    (err: Error & { code: number; stderr: string }) => err,
  )
  assert.strictEqual((unreadable as { code: number }).code, 2)
})

test('the CLI reads WRAP_ESM_LAMBDA_CONFIG, including a package specifier', async () => {
  // the same resolution rule as the runtime shell's --import entry, shared
  // through core so the two can never disagree about what a config name means
  const { stdout } = await execFileAsync(process.execPath, [cli], {
    cwd: fixtureDir,
    env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs') },
  })
  assert.match(stdout, /1 config entry against/)

  const err = await execFileAsync(process.execPath, [cli], {
    cwd: fixtureDir,
    env: { ...process.env, WRAP_ESM_LAMBDA_CONFIG: 'not-an-installed-package/config' },
  }).catch((e: Error & { stderr: string }) => e)
  assert.match((err as { stderr: string }).stderr, /neither an existing file nor a package specifier resolvable from/)
})

test('--json gives the same report as data', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, fixture('wrap.config.mjs'), '--json'], {
    cwd: fixtureDir,
  })
  const report = JSON.parse(stdout) as ValidationReport
  assert.strictEqual(report.ok, true)
  assert.strictEqual(report.entries.length, 1)
  assert.deepStrictEqual(report.counts, { ok: 1, skipped: 0, error: 0 })
})
