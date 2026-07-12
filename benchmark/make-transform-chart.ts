import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'

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
import { transformOxcInlineMap, transformOxcChainedToTs } from './oxc-sourcemap.js'
import { transformAcornInlineMap } from './acorn-sourcemap.js'

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
  { label: 'acorn', run: () => transformAcorn(testInput, 'handler', 'wrapper') },
  { label: 'acorn + source map', run: () => transformAcornInlineMap(testInput, 'handler', 'wrapper', 'handler.mjs') },
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

const canvas = new ChartJSNodeCanvas({ width: 800, height: 500, backgroundColour: '#333333', type: 'svg' })

const config = {
  type: 'bar' as const,
  data: {
    labels: results.map((r) => r.label),
    datasets: [
      {
        label: 'Transform latency [µs] (log scale, lower is better)',
        data: results.map((r) => Number(r.us.toFixed(2))),
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
    scales: {
      x: {
        type: 'logarithmic' as const,
        min: 0.5,
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
}

const outPath = fileURLToPath(new URL('../hooks/transformChart.svg', import.meta.url))
const buffer = canvas.renderToBufferSync(config)
fs.writeFileSync(outPath, buffer)
console.log(`\nWrote ${outPath}`)
