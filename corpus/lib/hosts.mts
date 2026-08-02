// The HOST harness: platforms that own their module graph (Next.js) are not
// tap targets — they are the process the runtime hook rides inside. The
// scope settled in docs/real-packages.md: patch ordinary SERVER-SIDE
// dependencies through the host, deliver the hook the way managed runtimes
// do (NODE_OPTIONS preload — it reaches every worker the host forks), and
// leave the client/HMR module graph alone by design.
//
// Two scenarios per host, both asserting from plain HTML that a
// server-rendered request crossed the patched dependency:
//   next-start  `next build` (unhooked) then the production server
//   next-dev    the dev server, compile-on-demand — the same preload
//               delivery holds under `next dev`, which is the honest answer
//               to "does this work with the dev server": server-side
//               dependencies, yes; the client HMR graph is out of scope.
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface HostResult {
  scenario: string
  cell: string
}

/** An OS-assigned free port, released immediately for the host to claim. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      server.close(() => resolve(address.port))
    })
    server.on('error', reject)
  })
}

const short = (text: string): string => {
  const line = text
    .split('\n')
    .find((l) => /error|Error|ERR_/.test(l))
    ?.trim()
  const value = line ?? text.trim().split('\n').at(-1) ?? 'no output'
  return value.length > 100 ? `${value.slice(0, 100)}…` : value
}

/** Serve via `next <mode>`, poll the SSR probe page, judge, tear down. */
async function serveAndProbe(
  nextBin: string,
  mode: 'start' | 'dev',
  hostDir: string,
  env: Record<string, string>,
  deadlineMs: number,
): Promise<string> {
  const port = await freePort()
  const child = spawn(nextBin, [mode, '-p', String(port)], {
    cwd: hostDir,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk))
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  try {
    const deadline = Date.now() + deadlineMs
    let lastError = 'server never answered'
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return `EXIT(${short(output)})`
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ssr`, { signal: AbortSignal.timeout(5000) })
        const text = await res.text()
        if (res.status !== 200) {
          lastError = `status ${res.status}`
        } else {
          const probe = /ssr:(\d+):2m/.exec(text)
          if (probe === null) return `MISS(no probe marker in page)`
          return Number(probe[1]) > 0 ? 'PATCHED' : 'MISSED'
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return `TIMEOUT(${short(output || lastError)})`
  } finally {
    if (child.pid !== undefined && child.exitCode === null) {
      // the dev server forks workers: signal the whole process group
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
      if (child.exitCode === null && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  }
}

export async function nextJsHost(corpusDir: string, hookEnv: Record<string, string>): Promise<HostResult[]> {
  const hostDir = join(corpusDir, 'hosts', 'nextjs')
  const nextBin = join(corpusDir, 'node_modules', '.bin', 'next')
  const env = { ...hookEnv, WRAP_ESM_LAMBDA_CONFIG: join(hostDir, 'wrap.config.mts') }

  // production build first, UNHOOKED: the build process is not the target,
  // the serving process is
  rmSync(join(hostDir, '.next'), { recursive: true, force: true })
  try {
    await execFileAsync(nextBin, ['build'], { cwd: hostDir, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string }
    const detail = short(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}` || String(failure.message))
    return [
      { scenario: 'next start (SSR)', cell: `BUILD_ERROR(${detail})` },
      { scenario: 'next dev (SSR)', cell: '—' },
    ]
  }

  const start = await serveAndProbe(nextBin, 'start', hostDir, env, 90_000)
  const dev = await serveAndProbe(nextBin, 'dev', hostDir, env, 240_000)
  return [
    { scenario: 'next start (SSR)', cell: start },
    { scenario: 'next dev (SSR)', cell: dev },
  ]
}
