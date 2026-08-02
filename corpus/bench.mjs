// Engine shoot-out over the corpus: the same full-surface identity tap,
// once per engine — native oxc vs pure-JS acorn — with repeated
// measurements (lib/bench-worker.mjs, one process per engine because the
// engine binds process-wide). Two things come out:
//
//   1. timing per corpus entry file (minimum of repeated runs of the real
//      pipeline, star walk included — see bench-worker.mjs for why min) —
//      the JS-vs-Rust trade-off measured on real packages instead of
//      synthetic fixtures;
//   2. a byte-equivalence assertion where byte-equivalence is actually
//      promised: on the APPEND tier the output is the untouched source plus
//      snippets, and the engines guarantee byte-identical snippets — so the
//      corpus asserts append-tier outputs hash-equal, the widest surface
//      available to hold them to it. REWRITE-tier output is engine-styled
//      by construction (oxc regenerates the module through codegen and
//      normalizes formatting; acorn edits via magic-string and preserves
//      it), so rewrite bytes and source maps are compared but only
//      reported; semantic parity of the rewrite is what run.mjs's identity
//      cells assert (and they pass under either engine).
//
//   node corpus/bench.mjs             # full corpus -> corpus/engines.md
//   node corpus/bench.mjs zod rxjs    # a subset (prints, does not write)
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { packages, keyFor } from './manifest.mjs'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const identityFrom = join(here, 'patches', 'identity.mjs')

const only = process.argv.slice(2)
const selected =
  only.length > 0 ? packages.filter((p) => only.includes(p.name) || only.includes(keyFor(p.name))) : packages
if (selected.length === 0) {
  console.error(`no manifest entry matches: ${only.join(', ')}`)
  process.exit(1)
}

const ENGINES = ['oxc', 'acorn']

async function benchCell(entry, engine) {
  const { stdout } = await execFileAsync(process.execPath, [join(here, 'lib', 'bench-worker.mjs')], {
    cwd: here,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      WRAP_ESM_LAMBDA_ENGINE: engine,
      CORPUS_PKG: entry.name,
      CORPUS_IDENTITY: identityFrom,
      ...(entry.targets && { CORPUS_TARGETS: entry.targets }),
      ...(entry.excludeBindings && { CORPUS_EXCLUDE: entry.excludeBindings.join(',') }),
    },
  })
  const report = JSON.parse(
    stdout
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('{')),
  )
  if (report.engine !== engine) {
    // the guard against a silent fallback making both columns the same engine
    throw new Error(`asked for engine '${engine}', worker bound '${report.engine}'`)
  }
  return report
}

const entryLabel = (pkg, file) => {
  const marker = `/node_modules/${pkg}/`
  const at = file.lastIndexOf(marker)
  return at === -1 ? file.split('/').at(-1) : file.slice(at + marker.length)
}
const fmtMs = (ms) => (ms >= 100 ? String(Math.round(ms)) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2))
const fmtKb = (bytes) => (bytes >= 102400 ? `${Math.round(bytes / 1024)}` : (bytes / 1024).toFixed(1))

// sequential on purpose: concurrent cells would perturb each other's timings
const rows = []
const mismatches = []
for (const entry of selected) {
  const reports = {}
  for (const engine of ENGINES) {
    try {
      reports[engine] = await benchCell(entry, engine)
    } catch (err) {
      console.error(`${entry.name} [${engine}]: ${String(err.message ?? err).slice(0, 120)}`)
      reports[engine] = null
    }
  }
  if (!reports.oxc || !reports.acorn) {
    mismatches.push(`${entry.name}: bench cell failed`)
    continue
  }
  for (let i = 0; i < reports.oxc.targets.length; i++) {
    const o = reports.oxc.targets[i]
    const a = reports.acorn.targets[i]
    const identical = o.hash === a.hash
    const mapsMatch = o.mapHash === a.mapHash
    // append output = source bytes + byte-identical snippets: a mismatch
    // there breaks the snippet-parity contract and fails the bench
    if (!identical && o.tier === 'append') {
      mismatches.push(`${entry.name} ${entryLabel(entry.name, o.file)}: append-tier outputs differ`)
    }
    rows.push({
      name: entry.name,
      version: reports.oxc.version,
      entry: entryLabel(entry.name, o.file),
      tier: o.tier,
      bindings: o.bindings.length,
      bytesIn: o.bytesIn,
      oxcMs: o.minMs,
      oxcIters: o.iterations,
      acornMs: a.minMs,
      acornIters: a.iterations,
      identical,
      mapsMatch,
    })
  }
  const line = rows
    .filter((r) => r.name === entry.name)
    .map((r) => `${r.entry} oxc:${fmtMs(r.oxcMs)} acorn:${fmtMs(r.acornMs)} ×${(r.acornMs / r.oxcMs).toFixed(1)}`)
    .join('  ')
  console.error(`${entry.name}@${reports.oxc.version}: ${line}`)
}

// ── table ────────────────────────────────────────────────────────────────────
const header = [
  'package',
  'entry',
  'tier',
  'bindings',
  'source KB',
  'oxc ms (min)',
  'acorn ms (min)',
  'acorn/oxc',
  'output',
]
const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => ' --- ').join('|')}|`]
for (const r of rows) {
  lines.push(
    `| ${[
      r.name,
      r.entry,
      r.tier,
      r.bindings,
      fmtKb(r.bytesIn),
      fmtMs(r.oxcMs),
      fmtMs(r.acornMs),
      `${(r.acornMs / r.oxcMs).toFixed(1)}×`,
      r.identical
        ? r.mapsMatch
          ? 'identical'
          : 'code = / maps ≠'
        : r.tier === 'rewrite'
          ? 'engine-styled'
          : '**DIFFERS**',
    ].join(' | ')} |`,
  )
}
const totalOxc = rows.reduce((s, r) => s + r.oxcMs, 0)
const totalAcorn = rows.reduce((s, r) => s + r.acornMs, 0)
const geomean = Math.exp(rows.reduce((s, r) => s + Math.log(r.acornMs / r.oxcMs), 0) / rows.length)
lines.push(
  `| **total** | ${rows.length} entries | | | | **${fmtMs(totalOxc)}** | **${fmtMs(totalAcorn)}** | **${(totalAcorn / totalOxc).toFixed(1)}×** | |`,
)

const md = [
  '# Engine benchmark on the corpus',
  '',
  '_Generated by `node corpus/bench.mjs` — do not edit. Minimum of repeated full-surface identity-tap transforms (the real `applyMatched` pipeline, star walk included) per corpus entry file; one process per engine._',
  '',
  `Node ${process.version} · ${cpus()[0]?.model ?? 'unknown CPU'} · oxc = native release addon, acorn = pure JS (@wrap-esm-lambda/engine-acorn)`,
  '',
  ...lines,
  '',
  `acorn/oxc: **${(totalAcorn / totalOxc).toFixed(1)}× on the summed corpus**, geometric mean **${geomean.toFixed(1)}×** per entry. Append-tier byte-parity (asserted): ${mismatches.length === 0 ? 'holds on every append entry' : `**${mismatches.length} MISMATCH(ES)** — see below`}. Rewrite-tier output is engine-styled by construction — oxc regenerates through codegen (normalized formatting), acorn edits via magic-string (original formatting preserved) — and source maps differ likewise (per-statement vs per-token); ${rows.filter((r) => !r.identical && r.tier === 'rewrite').length} rewrite entr${rows.filter((r) => !r.identical && r.tier === 'rewrite').length === 1 ? 'y is' : 'ies are'} engine-styled here. Semantic parity of the rewrite is asserted by run.mjs's identity cells, which pass under either engine.`,
  '',
  ...(mismatches.length > 0 ? [...mismatches.map((m) => `- ${m}`), ''] : []),
].join('\n')

if (only.length === 0) {
  writeFileSync(join(here, 'engines.md'), md)
  console.error(`written to ${join(here, 'engines.md')}`)
} else {
  console.log(md)
}

if (mismatches.length > 0) {
  console.error(`\n${mismatches.length} engine mismatch(es) — the byte-parity contract is broken:`)
  for (const m of mismatches) console.error(`  - ${m}`)
  process.exit(1)
}
console.error(
  `bench done: oxc ${fmtMs(totalOxc)}ms vs acorn ${fmtMs(totalAcorn)}ms (${(totalAcorn / totalOxc).toFixed(1)}×)`,
)
