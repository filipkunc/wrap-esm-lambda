import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
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
console.log('| tool | p50 | p95 | p99 | rme | samples |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const result of results.sort((a, b) => a.tool.localeCompare(b.tool))) {
  console.log(
    `| ${result.tool} | ${result.p50Us.toFixed(1)} µs | ${result.p95Us.toFixed(1)} µs | ${result.p99Us.toFixed(1)} µs | ±${result.rme.toFixed(1)}% | ${result.samples} |`,
  )
}
console.log('')
console.log('Transform only: setup, module evaluation, patch/subscriber execution and invocation cost are excluded.')
