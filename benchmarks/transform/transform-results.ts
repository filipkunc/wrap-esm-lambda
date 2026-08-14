import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TransformResult } from './transform-worker.js'

const execFileAsync = promisify(execFile)
const worker = fileURLToPath(new URL('./transform-worker.ts', import.meta.url))

export async function measureTransforms(): Promise<TransformResult[]> {
  const results: TransformResult[] = []
  for (const engine of ['oxc', 'acorn']) {
    const { stdout } = await execFileAsync(process.execPath, ['--import', '@oxc-node/core/register', worker], {
      env: { ...process.env, WRAP_ESM_LAMBDA_ENGINE: engine },
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    })
    const line = stdout.trim().split('\n').at(-1)
    if (!line) throw new Error(`no benchmark report from ${engine}`)
    results.push(...(JSON.parse(line) as TransformResult[]))
  }
  return results
}
