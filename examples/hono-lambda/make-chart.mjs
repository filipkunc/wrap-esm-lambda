// Renders coldStartChart.svg from coldStartTable.md — the same treatment
// hooks/make-chart.mjs gives the register-entry cold starts: horizontal
// bars, dark background, each bar's value printed at its right end because
// a static SVG has no tooltips. Data lives in the table, provenance
// included; this script only draws it.
import * as fs from 'node:fs'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'

const here = new URL('.', import.meta.url)
const tableLines = fs
  .readFileSync(new URL('coldStartTable.md', here), 'utf-8')
  .split('\n')
  .filter((line) => line.startsWith('| `'))

const labels = []
const billed = []
const rss = []
for (const line of tableLines) {
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
  labels.push(cells[0].slice(1, -1))
  billed.push(Number.parseFloat(cells[1]))
  rss.push(Number.parseFloat(cells[2]))
}

const canvas = new ChartJSNodeCanvas({ width: 800, height: 500, backgroundColour: '#333333', type: 'svg' })

const UNITS = ['ms', 'MB']
const barValueLabels = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart
    ctx.save()
    ctx.fillStyle = '#f2f0f0ff'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex)
      for (const [i, bar] of meta.data.entries()) {
        ctx.fillText(`${dataset.data[i].toFixed(0)} ${UNITS[datasetIndex] ?? ''}`, bar.x + 5, bar.y)
      }
    })
    ctx.restore()
  },
}

/** @type { import("chart.js").ChartConfiguration } */
const config = {
  type: 'bar',
  data: {
    datasets: [
      { label: 'Cold start, billed [ms]', data: billed, borderWidth: 1 },
      { label: 'In-process RSS [MB]', data: rss, borderWidth: 1 },
    ],
    labels,
  },
  options: {
    indexAxis: 'y',
    animation: false,
    responsive: false,
    maintainAspectRatio: false,
    // keep the longest bar's value label inside the canvas
    layout: { padding: { right: 70 } },
    scales: {
      x: { grid: { color: '#65656569' }, ticks: { color: '#f2f0f0ff' } },
      y: { grid: { color: '#65656569' }, ticks: { color: '#f2f0f0ff' } },
    },
    plugins: { legend: { display: true, labels: { color: '#f2f0f0ff' } } },
  },
  plugins: [barValueLabels],
}

fs.writeFileSync(new URL('coldStartChart.svg', here), canvas.renderToBufferSync(config))
console.log('rendered coldStartChart.svg')
