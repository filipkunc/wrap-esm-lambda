import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import type { Chart, Plugin } from 'chart.js'

import { transformLambda as transformBabel } from './babel-transform.js'
import { transformLambda as transformOxc } from '../index.js'
// @ts-expect-error next-line
import { transformLambda as transformSwc } from '../hooks/swc-wrapper.cjs'
import { transformLambda as transformAcorn } from './acorn-transform.js'
import { transformLambda as transformRegex } from './regex-transform.js'
import {
  transformLambdaTracing as transformOrchestrionTracing,
  transformLambdaMinimal as transformOrchestrionMinimal,
  transformLambdaMinimalCached as transformOrchestrionMinimalCached,
} from './orchestrion-transform.js'
import { transformOxcInlineMap, transformOxcChainedToTs, transformOxcChainedToTsRust } from './oxc-sourcemap.js'
import { transformAcornInlineMap, transformAcornChainedToTs } from './acorn-sourcemap.js'

const testInput = `export const handler = async function(event) {
	return "Hi from AWS Lambda";
}`

// Time one transform by running it under a fixed wall-clock budget, so the
// measurement stays meaningful across the ~3 orders of magnitude between the
// native regex path and the swc wasm plugin.
function measureUs(fn: () => void, warmupMs = 200, measureMs = 800): number {
  let end = performance.now() + warmupMs
  while (performance.now() < end) fn()
  let iters = 0
  const start = performance.now()
  end = start + measureMs
  while (performance.now() < end) {
    fn()
    iters++
  }
  return ((performance.now() - start) / iters) * 1000
}

const cases: { label: string; run: () => void }[] = [
  { label: 'regex', run: () => transformRegex(testInput, 'handler', 'wrapper') },
  { label: 'oxc.rs (native)', run: () => transformOxc(testInput, 'handler', 'wrapper') },
  { label: 'oxc.rs + source map', run: () => transformOxcInlineMap(testInput) },
  { label: 'oxc.rs + map chained to .ts', run: () => transformOxcChainedToTs() },
  { label: 'oxc.rs + map chained in Rust', run: () => transformOxcChainedToTsRust() },
  { label: 'acorn', run: () => transformAcorn(testInput, 'handler', 'wrapper') },
  { label: 'acorn + source map', run: () => transformAcornInlineMap(testInput, 'handler', 'wrapper', 'handler.mjs') },
  { label: 'acorn + map chained to .ts', run: () => transformAcornChainedToTs() },
  { label: 'orchestrion (cached selector)', run: () => transformOrchestrionMinimalCached(testInput) },
  { label: 'Babel', run: () => transformBabel(testInput, 'handler', 'wrapper') },
  { label: 'orchestrion (minimal wrap)', run: () => transformOrchestrionMinimal(testInput) },
  { label: 'orchestrion (tracing)', run: () => transformOrchestrionTracing(testInput) },
  { label: 'swc.rs (wasm)', run: () => transformSwc(testInput, 'handler', 'wrapper') },
]

const results = cases.map(({ label, run }) => ({ label, us: measureUs(run) })).sort((a, b) => a.us - b.us)

for (const { label, us } of results) {
  console.log(`${label.padEnd(32)} ${us.toFixed(1).padStart(9)} µs`)
}

// The fastest and slowest approaches are ~3 orders of magnitude apart: one
// linear chart squashes the fast group into slivers, and a log chart visually
// understates the differences that matter. So render two linear charts — one
// zoomed into the fast approaches where the interesting gaps live, one with
// the whole field for scale — with the exact value printed on each bar.
const FAST_LIMIT_US = 100

const canvas = new ChartJSNodeCanvas({ width: 800, height: 500, backgroundColour: '#333333', type: 'svg' })

// A static SVG has no tooltips, so print each bar's value at its right end.
const barValueLabels: Plugin<'bar'> = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart: Chart<'bar'>) {
    const { ctx } = chart
    const meta = chart.getDatasetMeta(0)
    const data = chart.data.datasets[0].data as number[]
    ctx.save()
    ctx.fillStyle = '#f2f0f0ff'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (const [i, bar] of meta.data.entries()) {
      ctx.fillText(`${data[i].toFixed(1)} µs`, bar.x + 6, bar.y)
    }
    ctx.restore()
  },
}

function renderChart(subset: { label: string; us: number }[], title: string, outName: string) {
  const config = {
    type: 'bar' as const,
    data: {
      labels: subset.map((r) => r.label),
      datasets: [
        {
          label: title,
          data: subset.map((r) => Number(r.us.toFixed(2))),
          backgroundColor: '#36a2eb',
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: 'y' as const,
      animation: false as const,
      responsive: false,
      maintainAspectRatio: false,
      // Keep the value label of the longest bar inside the canvas.
      layout: { padding: { right: 70 } },
      scales: {
        x: {
          min: 0,
          grid: { color: '#65656569' },
          ticks: { color: '#f2f0f0ff' },
        },
        y: {
          grid: { color: '#65656569' },
          ticks: { color: '#f2f0f0ff' },
        },
      },
      plugins: {
        legend: { display: true, labels: { color: '#f2f0f0ff' } },
      },
    },
    plugins: [barValueLabels],
  }
  const outPath = fileURLToPath(new URL(`../hooks/${outName}`, import.meta.url))
  fs.writeFileSync(outPath, canvas.renderToBufferSync(config))
  console.log(`Wrote ${outPath}`)
}

console.log()
renderChart(
  results.filter((r) => r.us < FAST_LIMIT_US),
  `Transform latency [µs], approaches under ${FAST_LIMIT_US} µs (lower is better)`,
  'transformChart.svg',
)
renderChart(results, 'Transform latency [µs], all approaches (lower is better)', 'transformChartAll.svg')
