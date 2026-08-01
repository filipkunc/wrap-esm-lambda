// The corpus runner: every manifest package goes through the same battery,
// results land in matrix.md, and any deviation from the manifest's expected
// outcomes fails the run (CI-friendly: pass, or fail loudly — never drift
// silently).
//
//   pnpm --dir corpus corpus              # full corpus
//   node corpus/run.mjs zod rxjs          # just these packages
//
// The battery, per package:
//   enumerate  resolve both entry conditions, enumerate the export surface,
//              time the real transform pipeline over it (tier + ms columns)
//   import     ESM consumer, control vs runtime-hooked identity patch —
//              patch must run, export surface fingerprint must not change
//   require    same through require() (require(esm) for pure-ESM packages)
//   build      esbuild parity: the same config through the unplugin; the
//              bundled app must observe the same surface, patched
//   hybrid     the instrumented bundle run again UNDER the runtime hook —
//              the sentinel must keep the patch count at exactly one
//   probe      optional behavioral micro-probe (probes/<key>.mjs): a real
//              two-line patch observed through the package's public API
//
// Plus two corpus-wide alarm checks (the loud half of the contract):
//   drift      a binding that does not exist must be a hard error
//   inert      a non-matching versionRange must patch nothing, error nothing
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { packages, keyFor } from './manifest.mjs'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const scratchRoot = join(here, '.scratch')
const identityFrom = join(here, 'patches', 'identity.mjs')
const fingerprintPath = join(here, 'lib', 'fingerprint.mjs')
const RUNS_KEY = "Symbol.for('wrap-esm-lambda-corpus.runs')"

// CORPUS FINDING, promoted to a floor: on pre-#59929-fix-train minors,
// require() of an ESM module whose source a sync load hook transformed
// fails to link its imports ("request for X is from a module not been
// linked"). Reproduced here through five real packages (nanoid, chalk,
// p-limit, execa, lodash-es): broken on 22.22.2 and 24.10.0, fixed on
// 22.22.3 and 24.11.1+ — exactly the fix-train boundary the interplay
// matrix pins for the Module._load corridors. The corpus therefore runs on
// post-fix minors only; on an older Node the require cells of every
// pure-ESM package would fail for this documented reason.
{
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  const postFix =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    (major === 24 && (minor > 11 || (minor === 11 && patch >= 1))) ||
    major >= 25
  if (!postFix) {
    console.error(
      `corpus needs Node ^22.22.3 || >=24.11.1 (require(esm)-of-transformed-module linking, nodejs/node#59929 fix train); got ${process.version}`,
    )
    process.exit(1)
  }
}

const only = process.argv.slice(2)
const selected =
  only.length > 0 ? packages.filter((p) => only.includes(p.name) || only.includes(keyFor(p.name))) : packages
if (selected.length === 0) {
  console.error(`no manifest entry matches: ${only.join(', ')}`)
  process.exit(1)
}

const NODE_TIMEOUT = 180_000
const baseEnv = { ...process.env }

async function runNode(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: here,
      env: { ...baseEnv, ...env },
      timeout: NODE_TIMEOUT,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { status: 0, stdout, stderr }
  } catch (err) {
    return { status: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) }
  }
}

function lastJson(stdout) {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('{'))
  if (!line) throw new Error(`no JSON report in output: ${stdout.slice(0, 200)}`)
  return JSON.parse(line)
}

function firstErrorLine(res) {
  const line =
    res.stderr
      .split('\n')
      .find((l) => /error|Error|ERR_/.test(l))
      ?.trim() ?? `exit ${res.status}`
  return line.length > 100 ? `${line.slice(0, 100)}…` : line
}

/** control vs hooked consumer reports -> one cell token (+ widening count) */
function judge(control, hookedRes, { compareFingerprints }, row) {
  if (hookedRes.status !== 0) return `ERROR(${firstErrorLine(hookedRes)})`
  const hooked = lastJson(hookedRes.stdout)
  if (control.runs !== 0) return 'AMBIENT'
  if (hooked.runs === 0) return 'MISSED'
  const { equal, detail, widened } = compareFingerprints(control.fingerprint, hooked.fingerprint)
  if (!equal) return `DIVERGED(${detail})`
  if (row && widened.length > 0) row.widened = Math.max(row.widened ?? 0, widened.length)
  return 'PATCHED'
}

function writeConfig(path, entries) {
  // patch.from and files are absolute already — no base argument needed
  writeFileSync(
    path,
    `import { definePatches } from '@wrap-esm-lambda/core'\nexport default definePatches(${JSON.stringify(entries, null, 2)})\n`,
  )
}

const hookArgs = ['--import', '@wrap-esm-lambda/hooks/register']
const hookedEnv = (configPath) => ({ WRAP_ESM_LAMBDA_CONFIG: configPath, WRAP_ESM_LAMBDA_STRICT: '1' })

async function runPackage(entry, helpers) {
  const key = keyFor(entry.name)
  const scratch = join(scratchRoot, key)
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  const row = { ...entry, key, cells: {} }

  // 1. enumerate + transform timing
  const enumRes = await runNode([join(here, 'lib', 'enumerate.mjs')], {
    CORPUS_PKG: entry.name,
    CORPUS_IDENTITY: identityFrom,
    ...(entry.targets ? { CORPUS_TARGETS: entry.targets } : {}),
    ...(entry.excludeBindings ? { CORPUS_EXCLUDE: entry.excludeBindings.join(',') } : {}),
  })
  if (enumRes.status !== 0) {
    row.error = `enumerate: ${firstErrorLine(enumRes)}`
    return row
  }
  const report = lastJson(enumRes.stdout)
  row.version = report.version
  row.engine = report.engine
  row.targets = report.targets

  // 2. identity config over the full surface
  const configPath = join(scratch, 'wrap.config.mjs')
  writeConfig(
    configPath,
    report.targets.map((t) => ({
      module: { name: entry.name, files: [t.file] },
      patch: { name: 'identityPatch', from: identityFrom },
      bindings: t.bindings,
    })),
  )

  // 3./4. consumer cells: control vs hooked, import and require
  for (const [cell, consumer] of [
    ['import', join(here, 'lib', 'consumer-import.mjs')],
    ['require', join(here, 'lib', 'consumer-require.cjs')],
  ]) {
    const controlRes = await runNode([consumer], { CORPUS_PKG: entry.name })
    if (controlRes.status !== 0) {
      row.cells[cell] = `CONTROL_ERROR(${firstErrorLine(controlRes)})`
      continue
    }
    const control = lastJson(controlRes.stdout)
    const hookedRes = await runNode([...hookArgs, consumer], {
      CORPUS_PKG: entry.name,
      ...hookedEnv(configPath),
    })
    row.cells[cell] = judge(control, hookedRes, helpers, row)
  }

  // 5./6. build parity + hybrid guard
  if (entry.build === false) {
    row.cells.build = '—'
    row.cells.hybrid = '—'
  } else {
    await buildCells(entry, row, scratch, configPath, helpers)
  }

  // 7. behavioral probe
  if (entry.probe) {
    const probeRes = await runNode([...hookArgs, join(here, 'probes', `${key}.mjs`)], {
      ...hookedEnv(join(here, 'probes', `${key}.config.mjs`)),
    })
    if (probeRes.status !== 0) row.cells.probe = `ERROR(${firstErrorLine(probeRes)})`
    else {
      const last = probeRes.stdout.trim().split('\n').at(-1)
      row.cells.probe = last === 'PROBE:OK' ? 'OK' : `FAIL(${last ?? 'no output'})`
    }
  } else {
    row.cells.probe = '—'
  }

  return row
}

async function buildCells(entry, row, scratch, configPath, helpers) {
  const { build } = await import('esbuild')
  const { unplugin } = await import('@wrap-esm-lambda/unplugin')
  const { default: config } = await import(pathToFileURL(configPath).href)

  const buildEntry = join(scratch, 'build-entry.mjs')
  writeFileSync(
    buildEntry,
    [
      `import { fingerprint } from ${JSON.stringify(fingerprintPath)}`,
      `import * as ns from ${JSON.stringify(entry.name)}`,
      `const runs = globalThis[${RUNS_KEY}] ?? 0`,
      `console.log(JSON.stringify({ runs, fingerprint: fingerprint(ns) }))`,
      '',
    ].join('\n'),
  )
  const shared = {
    entryPoints: [buildEntry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    external: entry.buildExternal ?? [],
    logLevel: 'silent',
  }
  const plainOut = join(scratch, 'bundle-plain.mjs')
  const tappedOut = join(scratch, 'bundle-tapped.mjs')
  try {
    await build({ ...shared, outfile: plainOut })
    await build({ ...shared, outfile: tappedOut, plugins: [unplugin.esbuild(config)] })
  } catch (err) {
    const msg = String(err?.errors?.[0]?.text ?? err.message ?? err).slice(0, 100)
    row.cells.build = `BUILD_ERROR(${msg})`
    row.cells.hybrid = '—'
    return
  }

  const controlRes = await runNode([plainOut])
  if (controlRes.status !== 0) {
    row.cells.build = `CONTROL_ERROR(${firstErrorLine(controlRes)})`
    row.cells.hybrid = '—'
    return
  }
  const control = lastJson(controlRes.stdout)
  const tappedRes = await runNode([tappedOut])
  row.cells.build = judge(control, tappedRes, helpers, row)
  if (row.cells.build !== 'PATCHED') {
    row.cells.hybrid = '—'
    return
  }

  // hybrid: the tapped bundle under the runtime hook — the sentinel must
  // hold the patch count exactly where the build-only run had it
  const buildRuns = lastJson(tappedRes.stdout).runs
  const hybridRes = await runNode([...hookArgs, tappedOut], hookedEnv(configPath))
  if (hybridRes.status !== 0) row.cells.hybrid = `ERROR(${firstErrorLine(hybridRes)})`
  else {
    const hybridRuns = lastJson(hybridRes.stdout).runs
    row.cells.hybrid = hybridRuns === buildRuns ? 'GUARDED' : `DOUBLE(${hybridRuns}!=${buildRuns})`
  }
}

/** The corpus-wide alarm checks, run against one well-behaved dual package. */
async function alarmChecks() {
  const scratch = join(scratchRoot, 'alarms')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  const target = fileURLToPath(import.meta.resolve('zod'))
  const cells = {}

  // drift: a binding that does not exist is a hard error under strict mode
  const driftConfig = join(scratch, 'drift.config.mjs')
  writeConfig(driftConfig, [
    {
      module: { name: 'zod', files: [target] },
      patch: { name: 'identityPatch', from: identityFrom },
      bindings: ['thisBindingDoesNotExist'],
    },
  ])
  const drift = await runNode([...hookArgs, join(here, 'lib', 'consumer-import.mjs')], {
    CORPUS_PKG: 'zod',
    ...hookedEnv(driftConfig),
  })
  cells.drift =
    drift.status !== 0 && /thisBindingDoesNotExist/.test(drift.stderr) ? 'LOUD' : `SILENT(exit ${drift.status})`

  // inert: a non-matching versionRange patches nothing and errors nothing
  const inertConfig = join(scratch, 'inert.config.mjs')
  writeConfig(inertConfig, [
    {
      module: { name: 'zod', versionRange: '<0.0.1', files: [target] },
      patch: { name: 'identityPatch', from: identityFrom },
      bindings: ['z'],
    },
  ])
  const inert = await runNode([...hookArgs, join(here, 'lib', 'consumer-import.mjs')], {
    CORPUS_PKG: 'zod',
    ...hookedEnv(inertConfig),
  })
  if (inert.status !== 0) cells.inert = `ERROR(${firstErrorLine(inert)})`
  else cells.inert = lastJson(inert.stdout).runs === 0 ? 'INERT' : 'PATCHED_ANYWAY'

  return cells
}

// ── drive ────────────────────────────────────────────────────────────────────
const { compareFingerprints } = await import('./lib/fingerprint.mjs')
const concurrency = Number(process.env.CORPUS_CONCURRENCY ?? 4)
const queue = [...selected]
const rows = []
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift()
      const row = await runPackage(entry, { compareFingerprints })
      const cellSummary = Object.entries(row.cells)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')
      console.error(`${row.name}@${row.version ?? '?'}: ${row.error ?? cellSummary}`)
      rows.push(row)
    }
  }),
)
const alarms = only.length === 0 ? await alarmChecks() : null
if (alarms) console.error(`alarms: drift:${alarms.drift} inert:${alarms.inert}`)

// ── expectations ─────────────────────────────────────────────────────────────
const deviations = []
for (const row of rows) {
  if (row.error) {
    deviations.push(`${row.name}: ${row.error}`)
    continue
  }
  const expected = {
    import: 'PATCHED',
    require: 'PATCHED',
    build: row.build === false ? '—' : 'PATCHED',
    hybrid: row.build === false ? '—' : 'GUARDED',
    probe: row.probe ? 'OK' : '—',
    ...row.expect,
  }
  for (const [cell, want] of Object.entries(expected)) {
    const got = row.cells[cell]
    if (got !== want) deviations.push(`${row.name}.${cell}: expected ${want}, got ${got}`)
  }
}
if (alarms) {
  if (alarms.drift !== 'LOUD') deviations.push(`alarms.drift: expected LOUD, got ${alarms.drift}`)
  if (alarms.inert !== 'INERT') deviations.push(`alarms.inert: expected INERT, got ${alarms.inert}`)
}

// ── matrix.md ────────────────────────────────────────────────────────────────
function shapeOf(row) {
  if (!row.targets) return '?'
  const formats = row.targets.map((t) => (t.format === 'module' ? 'esm' : 'cjs'))
  return formats.length > 1 ? 'dual' : formats[0]
}
const fmtMs = (ms) => (ms >= 100 ? String(Math.round(ms)) : ms.toFixed(1))
const groupOrder = ['handwritten-cjs', 'transpiled-cjs', 'dual', 'esm', 'instrumentation']
rows.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.name.localeCompare(b.name))

const header = [
  'package',
  'version',
  'group',
  'shape',
  'tier',
  'bindings',
  'transform ms',
  'import',
  'require',
  'build',
  'hybrid',
  'probe',
  'notes',
]
const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => ' --- ').join('|')}|`]
for (const row of rows) {
  const tiers = row.targets ? [...new Set(row.targets.map((t) => t.tier))].join('+') : '?'
  const bindings = row.targets ? Math.max(...row.targets.map((t) => t.bindings.length)) : '?'
  const ms = row.targets ? row.targets.map((t) => fmtMs(t.transformMs)).join(' / ') : '?'
  lines.push(
    `| ${[
      row.name,
      row.version ?? '?',
      row.group,
      shapeOf(row),
      tiers,
      bindings,
      ms,
      row.cells.import ?? '?',
      row.cells.require ?? '?',
      row.cells.build ?? '?',
      row.cells.hybrid ?? '?',
      row.cells.probe ?? '?',
      [row.notes, row.widened ? `tap makes +${row.widened} named exports lexer-visible` : null]
        .filter(Boolean)
        .join('; '),
    ].join(' | ')} |`,
  )
}

const engine = rows.find((r) => r.engine)?.engine ?? 'unknown'
const md = [
  '# Corpus results',
  '',
  '_Generated by `node corpus/run.mjs` — do not edit. See [README.md](README.md) for what each cell asserts._',
  '',
  `Engine: **${engine}** · Node: **${process.version}**`,
  '',
  ...lines,
  '',
  ...(alarms
    ? [
        `Alarm checks: missing binding → **${alarms.drift}** (expected LOUD), non-matching versionRange → **${alarms.inert}** (expected INERT).`,
        '',
      ]
    : []),
].join('\n')

if (only.length === 0) {
  writeFileSync(join(here, 'matrix.md'), md)
  console.error(`written to ${join(here, 'matrix.md')}`)
} else {
  console.log(md)
}

if (deviations.length > 0) {
  console.error(`\n${deviations.length} deviation(s) from expected outcomes:`)
  for (const d of deviations) console.error(`  - ${d}`)
  process.exit(1)
}
console.error('corpus green')
