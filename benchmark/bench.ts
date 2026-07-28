import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { cases, inputDescription, measureUs } from './tap-cases.js'

// The tap benchmark: transform latency on the real @smithy/core client file
// (the shared cases in tap-cases.ts, charted by `pnpm bench:chart`), then
// whole-process cold start for each hooking mechanism. Context and the
// numbers' interpretation: docs/benchmarks.md and docs/comparisons.md.

console.log(inputDescription + '\n')
for (const { label, run } of cases) {
  const us = measureUs(run)
  console.log(`${label.padEnd(55)} ${us.toFixed(1).padStart(9)} µs`)
}

// --- cold start: what each hooking mechanism adds to a whole process ---

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`../__test__/fixtures/patch/${name}`, import.meta.url))

async function medianSpawnMs(args: string[], env: NodeJS.ProcessEnv, expect: string): Promise<string> {
  const times: number[] = []
  for (let i = 0; i < 9; i++) {
    const start = performance.now()
    try {
      const { stdout } = await execFileAsync(process.execPath, args, { env })
      if (stdout.trim() !== expect) return `n/a (got '${stdout.trim()}')`
    } catch (err) {
      return `n/a (${(err as Error).message.split('\n')[1] ?? 'failed'})`
    }
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return `${times[Math.floor(times.length / 2)].toFixed(1)} ms`
}

const hookEnv = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.ts') }
const hookEnvMjs = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs') }
const coldStarts: [string, string[], NodeJS.ProcessEnv, string][] = [
  ['baseline (no instrumentation)', [fixture('app.mjs')], process.env, 'sent:hello'],
  [
    'exports tap runtime hook (.ts config)',
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    hookEnv,
    'patched:sent:hello',
  ],
  [
    'exports tap runtime hook (.mjs config)',
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    hookEnvMjs,
    'patched:sent:hello',
  ],
  [
    'exports tap runtime hook (acorn engine, .mjs config)',
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
    { ...hookEnvMjs, WRAP_ESM_LAMBDA_ENGINE: 'acorn' },
    'patched:sent:hello',
  ],
  [
    'iitm sync (registerHooks)',
    ['--import', fixture('iitm-setup.mjs'), fixture('app.mjs')],
    process.env,
    'iitm:sent:hello',
  ],
  [
    'iitm off-thread (module.register)',
    ['--import', fixture('iitm-setup-offthread.mjs'), fixture('app.mjs')],
    process.env,
    'iitm:sent:hello',
  ],
]

console.log(`\ncold start (median of 9 runs, node ${process.version}):`)
for (const [label, args, env, expect] of coldStarts) {
  console.log(`${label.padEnd(55)} ${(await medianSpawnMs(args, env, expect)).padStart(12)}`)
}
