// Drives the example through Core Tools — the real host, the real Node
// worker, real hook semantics — once per delivery shape, and asserts what the
// README promises: the bracket's report exists, carries every fake-agent hook
// (including the late-registered post hook), separates handler time from
// wrapper time, and closes after the last foreign post hook. Exits non-zero
// on the first broken promise; CI runs exactly this.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const exampleRoot = fileURLToPath(new URL('.', import.meta.url))
// Core Tools is deliberately NOT a dependency: its postinstall downloads host
// binaries from cdn.functions.azure.com, which restricted networks block, and
// that must not break the workspace install. Install it yourself
// (`npm i -g azure-functions-core-tools@4`) or point FUNC_BIN at it.
const funcBin = process.env.FUNC_BIN ?? 'func'
const port = process.env.PORT ?? '7133'
const baseUrl = `http://127.0.0.1:${port}/api/hello`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
const check = (mode, what, ok, detail = '') => {
  const verdict = ok ? 'ok' : 'FAIL'
  console.log(`  [${mode}] ${verdict}: ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(`[${mode}] ${what}`)
}

async function startFunc(env) {
  const child = spawn(funcBin, ['start', '--port', port], {
    cwd: exampleRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // its own process group: func spawns the host and the worker
  })
  let output = ''
  const onChunk = (chunk) => {
    output += chunk
    if (process.env.WRAP_ESM_LAMBDA_DEBUG) process.stdout.write(chunk)
  }
  child.stdout.setEncoding('utf8').on('data', onChunk)
  child.stderr.setEncoding('utf8').on('data', onChunk)
  return { child, getOutput: () => output }
}

async function stopFunc(child) {
  try {
    process.kill(-child.pid, 'SIGINT')
  } catch {
    return
  }
  const gone = await Promise.race([once(child, 'exit').then(() => true), sleep(10_000).then(() => false)])
  if (!gone) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
}

async function waitReady(getOutput, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}?name=ready`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return await response.text()
    } catch {}
    await sleep(500)
  }
  throw new Error(`func start not answering on ${baseUrl} after ${timeoutMs}ms; output so far:\n${getOutput()}`)
}

// the host relays worker console lines through its own logger — strip any
// coloring so a marker's JSON payload parses whatever the log formatting does
const stripAnsi = (text) => text.replace(/\[[0-9;]*m/g, '')

function parseMarkers(output, prefix) {
  return stripAnsi(output)
    .split('\n')
    .filter((line) => line.includes(prefix))
    .map((line) => JSON.parse(line.slice(line.indexOf(prefix) + prefix.length).trim()))
}

async function runMode(mode, env) {
  console.log(`\n=== delivery: ${mode} ===`)
  const { child, getOutput } = await startFunc(env)
  try {
    const readyBody = await waitReady(getOutput)
    check(mode, 'HTTP trigger answers', readyBody.includes('Hello, ready!'), JSON.stringify(readyBody))
    // two labeled invocations beyond the readiness one
    for (const name of ['first', 'second']) {
      const response = await fetch(`${baseUrl}?name=${name}`)
      check(mode, `invocation '${name}' succeeds`, response.ok && (await response.text()) === `Hello, ${name}!`)
    }
    await sleep(1500) // let the last invocation's logs flush through the host
  } finally {
    await stopFunc(child)
  }
  const output = getOutput()

  if (mode === 'prelude') {
    check(mode, 'prelude activation succeeded', output.includes('WRAPESM:prelude-activated true'))
  }
  check(mode, 'fake agent found the core module', !output.includes('FAKEAPM:no-core'))

  const registrations = parseMarkers(output, 'WRAPESM:registration ')
  const registered = registrations.map((registration) => registration.hookName).sort()
  check(
    mode,
    'choke point saw all four fake-agent registrations (core pre/post, late post, library post)',
    JSON.stringify(registered) ===
      JSON.stringify(['postInvocation', 'postInvocation', 'postInvocation', 'preInvocation']),
    JSON.stringify(registered),
  )
  check(
    mode,
    'registrations attributed (no unknowns)',
    registrations.length > 0 && registrations.every((registration) => registration.registrant !== 'unknown'),
    JSON.stringify(registrations.map((registration) => registration.registrant)),
  )

  const reports = parseMarkers(output, 'WRAPESM:report ')
  check(mode, 'every invocation produced a report', reports.length >= 3, `${reports.length} reports`)
  const report = reports.at(-1)
  if (report) {
    const postTimings = report.hookTimings.filter((timing) => timing.hookName === 'postInvocation')
    check(
      mode,
      'the closing hook ran after all three foreign post hooks',
      postTimings.length === 3,
      JSON.stringify(report.hookTimings),
    )
    check(
      mode,
      'the opening hook ran before the foreign pre hook',
      report.hookTimings.some((timing) => timing.hookName === 'preInvocation'),
    )
    check(mode, 'handler timed innermost', report.handlerMs >= 10, `${report.handlerMs}ms`)
    check(
      mode,
      "callback phase carries the fake wrapper's cost",
      report.callbackMs >= report.handlerMs + 3,
      `callback ${report.callbackMs}ms vs handler ${report.handlerMs}ms`,
    )
    check(mode, 'the bracket surrounds everything', report.totalMs >= report.callbackMs, `total ${report.totalMs}ms`)
    check(mode, 'the fake wrapper was detected', report.callbackReplaced === true)
    check(mode, 'nothing bypassed the handler', report.handlerBypassed === false)
    // the report line must appear after the last foreign post-hook line of
    // that invocation — "last" observed on stdout, not just claimed
    const lastReportAt = output.lastIndexOf('WRAPESM:report ')
    const lastFakePostAt = Math.max(output.lastIndexOf('FAKEAPM:post'), output.lastIndexOf('FAKEAPM:post-late'))
    check(mode, 'report printed after the last foreign post hook', lastReportAt > lastFakePostAt)
  }
}

// a file: URL: the host splits this setting on spaces with no quoting rules,
// and a URL never contains one
const registerEntry = import.meta.resolve('@wrap-esm-lambda/hooks/register')
await runMode('preload', {
  languageWorkers__node__arguments: `--import ${registerEntry}`,
  WRAP_ESM_LAMBDA_CONFIG: resolve(exampleRoot, 'wrap.config.mjs'),
})
await runMode('prelude', { EXAMPLE_DELIVERY: 'prelude' })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('\nall checks passed, both delivery shapes')
