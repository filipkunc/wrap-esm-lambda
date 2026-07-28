import * as fs from 'node:fs'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'

let commands = []
let times = []
let memory = []

/** @type { string[] } */
let benchTableLines = fs.readFileSync('benchTable.md', 'utf-8').split('\n')
benchTableLines.splice(1, 1)
for (let i = 0; i < benchTableLines.length; ++i) {
  let entries = benchTableLines[i].split('|').slice(1, -1)
  for (let j = 0; j < entries.length; ++j) {
    entries[j] = entries[j].trim()
    if (entries[j].startsWith('`')) {
      entries[j] = entries[j].slice(1, -1)
    }
  }
  benchTableLines[i] = entries.join(',')
  if (i > 0 && benchTableLines[i].length > 0) {
    commands.push(
      entries[0].replace('runtime.mjs', '').replace('node --import', '').replace('./', '').replace('.mjs', ''),
    )
    times.push(+entries[1].split('±')[0])
    memory.push(+entries[entries.length - 1])
  }
}

const canvas = new ChartJSNodeCanvas({ width: 800, height: 500, backgroundColour: '#333333', type: 'svg' })

// A static SVG has no tooltips, so print each bar's value at its right end —
// the same treatment the transform-latency charts give their bars. One label
// per bar, unit taken from the dataset it belongs to.
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
        ctx.fillText(`${dataset.data[i].toFixed(1)} ${UNITS[datasetIndex] ?? ''}`, bar.x + 5, bar.y)
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
      {
        label: 'Mean [ms]',
        data: times,
        borderWidth: 1,
      },
      {
        label: 'Max RSS [MB]',
        data: memory,
        borderWidth: 1,
      },
    ],
    labels: commands,
  },
  options: {
    indexAxis: 'y',
    animation: false,
    responsive: false,
    maintainAspectRatio: false,
    // keep the longest bar's value label inside the canvas
    layout: { padding: { right: 70 } },
    scales: {
      x: {
        grid: {
          color: '#65656569',
        },
        ticks: {
          color: '#f2f0f0ff',
        },
      },
      y: {
        grid: {
          color: '#65656569',
        },
        ticks: {
          color: '#f2f0f0ff',
        },
      },
    },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: '#f2f0f0ff',
        },
      },
    },
  },
  plugins: [barValueLabels],
}

const buffer = canvas.renderToBufferSync(config)
fs.writeFileSync('benchChart.svg', buffer)
