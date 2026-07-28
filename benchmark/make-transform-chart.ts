import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import type { Chart, Plugin } from 'chart.js'

import { cases, inputDescription, measureUs } from './tap-cases.js'

// Charts for the tap transform-latency comparison (the same cases `pnpm
// bench` prints as a table — see tap-cases.ts). Two charts, split by what
// they compare rather than by speed:
// - the MECHANISM chart is apples-to-apples across tools: one bar per tool,
//   all doing their per-module analysis/transform of the same 1.8 KB file;
// - the ENGINE chart is this package's two engines in detail — tiers,
//   string-vs-buffer plumbing, input sizes — where variants within one tool
//   are the meaningful comparison.
// Both are linear with the exact value printed on each bar: on the
// mechanism chart the ~100x gap IS the story, and a log axis would
// visually understate it.

console.log(inputDescription + '\n')
const results = cases
  .map(({ label, run, mechanism }) => ({ label, mechanism: mechanism === true, us: measureUs(run) }))
  .sort((a, b) => a.us - b.us)

for (const { label, us } of results) {
  console.log(`${label.padEnd(55)} ${us.toFixed(1).padStart(9)} µs`)
}

const canvas = new ChartJSNodeCanvas({ width: 1000, height: 500, backgroundColour: '#333333', type: 'svg' })

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
  results.filter((r) => r.mechanism),
  'Per-module transform cost [µs] — one bar per tool, same 1.8 KB module (lower is better)',
  'tapMechanismChart.svg',
)
renderChart(
  results.filter((r) => r.label.startsWith('oxc') || r.label.startsWith('acorn')),
  'The two engines in detail [µs] — tiers, plumbing, input sizes (lower is better)',
  'tapEngineChart.svg',
)
