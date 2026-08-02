// Engine shoot-out over the corpus: the same full-surface identity tap,
// once per engine — native oxc vs pure-JS acorn — with repeated
// measurements (lib/bench-worker.mts, one process per engine because the
// engine binds process-wide). Two things come out:
//
//   1. timing per corpus entry file (minimum of repeated runs of the real
//      pipeline, star walk included — see bench-worker.mts for why min) —
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
//      reported; semantic parity of the rewrite is what run.mts's identity
//      cells assert (and they pass under either engine).
//
//   node corpus/bench.mts             # full corpus -> corpus/engines.md
//   node corpus/bench.mts zod rxjs    # a subset (prints, does not write)
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { packages, keyFor } from './manifest.mts'
import type { CorpusEntry } from './manifest.mts'
import type { BenchReport } from './lib/bench-worker.mts'

interface BenchRow {
  name: string
  version: string
  entry: string
  tier: 'append' | 'rewrite'
  bindings: number
  bytesIn: number
  oxcMs: number
  oxcIters: number
  acornMs: number
  acornIters: number
  identical: boolean
  mapsMatch: boolean
}

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const identityFrom = join(here, 'patches', 'identity.mts')

const only = process.argv.slice(2)
const selected =
  only.length > 0 ? packages.filter((p) => only.includes(p.name) || only.includes(keyFor(p.name))) : packages
if (selected.length === 0) {
  console.error(`no manifest entry matches: ${only.join(', ')}`)
  process.exit(1)
}

const ENGINES = ['oxc', 'acorn'] as const
type EngineName = (typeof ENGINES)[number]

async function benchCell(entry: CorpusEntry, engine: EngineName): Promise<BenchReport> {
  const { stdout } = await execFileAsync(process.execPath, [join(here, 'lib', 'bench-worker.mts')], {
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
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('{'))
  if (!line) throw new Error(`no JSON report from bench worker: ${stdout.slice(0, 200)}`)
  const report = JSON.parse(line) as BenchReport
  if (report.engine !== engine) {
    // the guard against a silent fallback making both columns the same engine
    throw new Error(`asked for engine '${engine}', worker bound '${report.engine}'`)
  }
  return report
}

const entryLabel = (pkg: string, file: string): string => {
  const marker = `/node_modules/${pkg}/`
  const at = file.lastIndexOf(marker)
  return at === -1 ? (file.split('/').at(-1) ?? file) : file.slice(at + marker.length)
}
const fmtMs = (ms: number): string => (ms >= 100 ? String(Math.round(ms)) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2))
const fmtKb = (bytes: number): string => (bytes >= 102400 ? `${Math.round(bytes / 1024)}` : (bytes / 1024).toFixed(1))

// sequential on purpose: concurrent cells would perturb each other's timings
const rows: BenchRow[] = []
const mismatches: string[] = []
for (const entry of selected) {
  const reports: Partial<Record<EngineName, BenchReport>> = {}
  for (const engine of ENGINES) {
    try {
      reports[engine] = await benchCell(entry, engine)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`${entry.name} [${engine}]: ${message.slice(0, 120)}`)
    }
  }
  const oxcReport = reports.oxc
  const acornReport = reports.acorn
  if (!oxcReport || !acornReport) {
    mismatches.push(`${entry.name}: bench cell failed`)
    continue
  }
  for (let i = 0; i < oxcReport.targets.length; i++) {
    const o = oxcReport.targets[i]!
    const a = acornReport.targets[i]!
    const identical = o.hash === a.hash
    const mapsMatch = o.mapHash === a.mapHash
    // append output = source bytes + byte-identical snippets: a mismatch
    // there breaks the snippet-parity contract and fails the bench
    if (!identical && o.tier === 'append') {
      mismatches.push(`${entry.name} ${entryLabel(entry.name, o.file)}: append-tier outputs differ`)
    }
    rows.push({
      name: entry.name,
      version: oxcReport.version,
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
  console.error(`${entry.name}@${oxcReport.version}: ${line}`)
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

const styledRewrites = rows.filter((r) => !r.identical && r.tier === 'rewrite').length
const md = [
  '# Engine benchmark on the corpus',
  '',
  '_Generated by `node corpus/bench.mts` — do not edit. Minimum of repeated full-surface identity-tap transforms (the real `applyMatched` pipeline, star walk included) per corpus entry file; one process per engine._',
  '',
  '![oxc vs acorn per corpus entry — dumbbell dot plot, log time axis](engines.svg)',
  '',
  `Node ${process.version} · ${cpus()[0]?.model ?? 'unknown CPU'} · oxc = native release addon, acorn = pure JS (@wrap-esm-lambda/engine-acorn)`,
  '',
  ...lines,
  '',
  `acorn/oxc: **${(totalAcorn / totalOxc).toFixed(1)}× on the summed corpus**, geometric mean **${geomean.toFixed(1)}×** per entry. Append-tier byte-parity (asserted): ${mismatches.length === 0 ? 'holds on every append entry' : `**${mismatches.length} MISMATCH(ES)** — see below`}. Rewrite-tier output is engine-styled by construction — oxc regenerates through codegen (normalized formatting), acorn edits via magic-string (original formatting preserved) — and source maps differ likewise (per-statement vs per-token); ${styledRewrites} rewrite entr${styledRewrites === 1 ? 'y is' : 'ies are'} engine-styled here. Semantic parity of the rewrite is asserted by run.mts's identity cells, which pass under either engine.`,
  '',
  ...(mismatches.length > 0 ? [...mismatches.map((m) => `- ${m}`), ''] : []),
].join('\n')

if (only.length === 0) {
  writeFileSync(join(here, 'engines.md'), md)
  console.error(`written to ${join(here, 'engines.md')}`)
  try {
    await renderChart(rows, join(here, 'engines.svg'))
    console.error(`written to ${join(here, 'engines.svg')}`)
  } catch (err) {
    // the chart needs the native canvas module; a platform without it still
    // gets the tables — the chart is presentation, never the check
    console.error(`chart skipped: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
} else {
  console.log(md)
}

/**
 * The dumbbell dot plot behind engines.md: one row per corpus entry file,
 * two dots (oxc, acorn) on a LOG time axis — position encoding, so the log
 * scale is legitimate where bar length would not be (the corpus spans
 * 0.02ms micro-entries to 100ms+ star walks). The visual gap between the
 * paired dots IS the ratio. Palette: two categorical slots validated for
 * the dark surface (CVD ΔE 26.8, all six checks pass); series identity is
 * also carried by dot shape, so the chart survives grayscale.
 */
async function renderChart(benchRows: BenchRow[], outPath: string): Promise<void> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas')
  // structural stand-ins: no DOM lib in this tsconfig, and only these few
  // canvas members are touched
  interface CtxLike {
    save(): void
    restore(): void
    beginPath(): void
    moveTo(x: number, y: number): void
    lineTo(x: number, y: number): void
    stroke(): void
    strokeStyle: string
    lineWidth: number
  }
  type ChartLike = { getDatasetMeta: (i: number) => { data: { x: number; y: number }[] }; ctx: CtxLike }

  const SURFACE = '#1a1a19'
  const TEXT_PRIMARY = '#ffffff'
  const TEXT_SECONDARY = '#c3c2b7'
  const GRID = '#3a3a38'
  const OXC = '#3987e5'
  const ACORN = '#d95926'

  const sorted = [...benchRows].sort((a, b) => b.oxcMs - a.oxcMs)
  const labels = sorted.map((r) => `${r.name} · ${r.entry}`)
  const height = 110 + sorted.length * 24
  const canvas = new ChartJSNodeCanvas({ width: 1080, height, backgroundColour: SURFACE, type: 'svg' })

  // the connector between each pair — drawn under the dots, in muted ink so
  // the series colors stay the only identity carriers
  const dumbbellConnectors = {
    id: 'dumbbellConnectors',
    beforeDatasetsDraw(chart: ChartLike) {
      const oxcMeta = chart.getDatasetMeta(0).data
      const acornMeta = chart.getDatasetMeta(1).data
      const { ctx } = chart
      ctx.save()
      ctx.strokeStyle = GRID
      ctx.lineWidth = 2
      for (let i = 0; i < oxcMeta.length; i++) {
        const a = oxcMeta[i]
        const b = acornMeta[i]
        if (!a || !b) continue
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      ctx.restore()
    },
  }

  const config = {
    type: 'scatter' as const,
    data: {
      datasets: [
        {
          label: 'oxc (native)',
          data: sorted.map((r, i) => ({ x: r.oxcMs, y: i })),
          backgroundColor: OXC,
          pointStyle: 'circle' as const,
          pointRadius: 5,
          pointBorderColor: SURFACE,
          pointBorderWidth: 1,
        },
        {
          label: 'acorn (pure JS)',
          data: sorted.map((r, i) => ({ x: r.acornMs, y: i })),
          backgroundColor: ACORN,
          pointStyle: 'rectRot' as const,
          pointRadius: 5,
          pointBorderColor: SURFACE,
          pointBorderWidth: 1,
        },
      ],
    },
    options: {
      animation: false as const,
      responsive: false,
      maintainAspectRatio: false,
      layout: { padding: { right: 24, left: 8 } },
      scales: {
        x: {
          type: 'logarithmic' as const,
          title: {
            display: true,
            text: 'full-surface identity-tap transform — min of repeated runs, ms (log scale, lower is better)',
            color: TEXT_SECONDARY,
            font: { size: 12 },
          },
          grid: { color: GRID },
          ticks: { color: TEXT_SECONDARY, font: { size: 11 } },
        },
        y: {
          type: 'linear' as const,
          reverse: true,
          min: -0.6,
          max: sorted.length - 0.4,
          grid: { display: false },
          ticks: {
            stepSize: 1,
            autoSkip: false,
            color: TEXT_PRIMARY,
            font: { size: 11 },
            callback: (value: unknown) => labels[Number(value)] ?? '',
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          labels: { color: TEXT_PRIMARY, usePointStyle: true, font: { size: 12 } },
        },
        title: {
          display: true,
          text: 'Engine shoot-out on the corpus — oxc vs acorn per entry file',
          color: TEXT_PRIMARY,
          font: { size: 14 },
        },
      },
    },
    plugins: [dumbbellConnectors],
  }
  // chartjs-node-canvas's types predate this config shape; the runtime accepts it
  writeFileSync(outPath, canvas.renderToBufferSync(config as never))
}

if (mismatches.length > 0) {
  console.error(`\n${mismatches.length} engine mismatch(es) — the byte-parity contract is broken:`)
  for (const m of mismatches) console.error(`  - ${m}`)
  process.exit(1)
}
console.error(
  `bench done: oxc ${fmtMs(totalOxc)}ms vs acorn ${fmtMs(totalAcorn)}ms (${(totalAcorn / totalOxc).toFixed(1)}×)`,
)
