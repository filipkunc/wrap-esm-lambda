import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import type { Chart, Plugin } from 'chart.js'

import { measureTransforms } from './transform-results.js'

// One chart, one comparison: the production applyMatched() pipeline under
// OXC and Acorn. Cross-tool value belongs in whole-process cold-start data,
// where each mechanism is allowed to perform its actual job.
const results = await measureTransforms()
for (const result of results) {
  console.log(
    `${`${result.engine}: ${result.operation}`.padEnd(74)} p50 ${result.p50Us.toFixed(1)} µs · p99 ${result.p99Us.toFixed(1)} µs`,
  )
}

const canvas = new ChartJSNodeCanvas({ width: 1100, height: 650, backgroundColour: '#333333', type: 'svg' })

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
      ctx.fillText(`p50 ${data[i].toFixed(1)} · p99 ${results[i]!.p99Us.toFixed(1)} µs`, bar.x + 6, bar.y)
    }
    ctx.restore()
  },
}

const config = {
  type: 'bar' as const,
  data: {
    labels: results.map((result) => `${result.engine}: ${result.operation}`),
    datasets: [
      {
        label: 'Production transform p50 [µs] — Tinybench (lower is better)',
        data: results.map((result) => Number(result.p50Us.toFixed(2))),
        backgroundColor: results.map((result) => (result.engine === 'oxc' ? '#36a2eb' : '#ff9f40')),
        borderWidth: 1,
      },
    ],
  },
  options: {
    indexAxis: 'y' as const,
    animation: false as const,
    responsive: false,
    maintainAspectRatio: false,
    layout: { padding: { right: 170 } },
    scales: {
      x: { min: 0, grid: { color: '#65656569' }, ticks: { color: '#f2f0f0ff' } },
      y: { grid: { color: '#65656569' }, ticks: { color: '#f2f0f0ff' } },
    },
    plugins: { legend: { display: true, labels: { color: '#f2f0f0ff' } } },
  },
  plugins: [barValueLabels],
}

const outPath = fileURLToPath(new URL('../hooks/tapEngineChart.svg', import.meta.url))
fs.writeFileSync(outPath, canvas.renderToBufferSync(config))
console.log(`Wrote ${outPath}`)
