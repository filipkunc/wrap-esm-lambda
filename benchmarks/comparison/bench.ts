import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import type { Chart, Plugin } from 'chart.js'
import type { ComparisonResult } from './worker.js'

const execFileAsync = promisify(execFile)
const worker = fileURLToPath(new URL('./worker.ts', import.meta.url))
const tools = Math.random() < 0.5 ? ['wrap-esm-lambda', 'orchestrion'] : ['orchestrion', 'wrap-esm-lambda']
const results: ComparisonResult[] = []

for (const tool of tools) {
  const { stdout } = await execFileAsync(process.execPath, ['--import', '@oxc-node/core/register', worker, tool], {
    env: process.env,
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  })
  const line = stdout.trim().split('\n').at(-1)
  if (!line) throw new Error(`no benchmark report from ${tool}`)
  results.push(JSON.parse(line) as ComparisonResult)
}

const environment = results[0]?.environment
if (!environment) throw new Error('comparison produced no results')
console.log('Equivalent transform diagnostic (isolated child process per tool)')
console.log(results[0].operation)
console.log(
  `Node ${environment.node} · ${environment.platform}/${environment.arch} · ${environment.cpu}\n` +
    `wrap-esm-lambda ${environment.wrapEsmLambda} · orchestrion ${environment.orchestrion} · @smithy/core ${environment.smithyCore}`,
)
console.log('')
const sorted = results.sort((a, b) => a.tool.localeCompare(b.tool))
const table = [
  '| tool | p50 | p95 | p99 | rme | samples |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...sorted.map(
    (result) =>
      `| ${result.tool} | ${result.p50Us.toFixed(1)} µs | ${result.p95Us.toFixed(1)} µs | ${result.p99Us.toFixed(1)} µs | ±${result.rme.toFixed(1)}% | ${result.samples} |`,
  ),
].join('\n')
console.log(table)
console.log('')
const scope = 'Transform only: setup, module evaluation, patch/subscriber execution and invocation cost are excluded.'
console.log(scope)

const outputDir = process.env.BENCH_COMPARE_OUTPUT_DIR
if (outputDir) {
  const directory = resolve(outputDir)
  mkdirSync(directory, { recursive: true })

  const metadata =
    `Node ${environment.node} · ${environment.platform}/${environment.arch} · ${environment.cpu}\n\n` +
    `wrap-esm-lambda ${environment.wrapEsmLambda} · orchestrion ${environment.orchestrion} · @smithy/core ${environment.smithyCore}`
  const markdown = [
    '## Equivalent Orchestrion transform diagnostic',
    '',
    results[0].operation,
    '',
    metadata,
    '',
    table,
    '',
    `_${scope}_`,
    '',
  ].join('\n')
  writeFileSync(resolve(directory, 'orchestrionComparison.md'), markdown)
  writeFileSync(
    resolve(directory, 'orchestrionComparison.json'),
    `${JSON.stringify({ operation: results[0].operation, environment, results: sorted }, null, 2)}\n`,
  )

  const valueLabels: Plugin<'bar'> = {
    id: 'comparisonValueLabels',
    afterDatasetsDraw(chart: Chart<'bar'>) {
      const { ctx } = chart
      ctx.save()
      ctx.fillStyle = '#f2f0f0ff'
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const data = dataset.data as number[]
        for (const [index, bar] of chart.getDatasetMeta(datasetIndex).data.entries()) {
          ctx.fillText(`${data[index].toFixed(1)} µs`, bar.x + 5, bar.y)
        }
      })
      ctx.restore()
    },
  }
  const canvas = new ChartJSNodeCanvas({
    width: 1000,
    height: 450,
    backgroundColour: '#333333',
    type: 'svg',
  })
  const config = {
    type: 'bar' as const,
    data: {
      labels: sorted.map((result) => result.tool),
      datasets: [
        { label: 'p50', data: sorted.map((result) => result.p50Us), backgroundColor: '#36a2eb' },
        { label: 'p95', data: sorted.map((result) => result.p95Us), backgroundColor: '#ff9f40' },
        { label: 'p99', data: sorted.map((result) => result.p99Us), backgroundColor: '#ff6384' },
      ],
    },
    options: {
      indexAxis: 'y' as const,
      animation: false as const,
      responsive: false,
      maintainAspectRatio: false,
      layout: { padding: { right: 95 } },
      scales: {
        x: {
          type: 'logarithmic' as const,
          min: 1,
          title: { display: true, text: 'transform latency [µs] — logarithmic scale, lower is better' },
          grid: { color: '#65656569' },
          ticks: { color: '#f2f0f0ff' },
        },
        y: { grid: { color: '#65656569' }, ticks: { color: '#f2f0f0ff' } },
      },
      plugins: {
        title: {
          display: true,
          text: 'Equivalent Client#send transform diagnostic',
          color: '#f2f0f0ff',
        },
        legend: { display: true, labels: { color: '#f2f0f0ff' } },
      },
    },
    plugins: [valueLabels],
  }
  writeFileSync(resolve(directory, 'orchestrionComparison.svg'), canvas.renderToBufferSync(config))
}
