// Failure policy, shared by both shells. Instrumentation sits in the load
// path of every module of a process it does not own, so the failure mode that
// matters is not "did the patch work" but "what happens when it doesn't":
// a version-drifted binding, a dependency file the parser chokes on, a patch
// function with a bug in it. None of those may take the host process down.
//
// The rule the shells apply: fail soft wherever partial degradation exists
// (one entry dropped, one module left untouched, the pure-JS engine instead of
// the native one) and stay loud where there is nothing to degrade to (a
// missing or unreadable config — see @wrap-esm-lambda/hooks/register). Core's
// own transform functions never recover; they throw, and the shell above them
// decides. The build shell keeps throwing on purpose: a failing build is
// visible and cheap, a silently un-instrumented artifact is not.
//
// Three environment switches, all readable at call time so an embedder can
// flip them before registering:
//
//   WRAP_ESM_LAMBDA_DISABLE=1  kill switch — no hooks, no patches, no
//                              transform. The lever for mitigating an
//                              incident without redeploying the app's start
//                              command.
//   WRAP_ESM_LAMBDA_STRICT=1   turn every recovered failure back into a
//                              throw. What CI and the test suite run with;
//                              also the way to debug a patch that silently
//                              isn't applying.
//   WRAP_ESM_LAMBDA_DEBUG=1    trace decisions (engine, matches, skips,
//                              rewrites) to stderr.

/** `1`, `true`, any non-empty value except `0`/`false`. Unset is off. */
function envFlag(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/** Kill switch: the shells skip registration entirely. Read at call time. */
export function isDisabled(): boolean {
  return envFlag('WRAP_ESM_LAMBDA_DISABLE')
}

/** Strict mode: `recover` rethrows instead of warning. Read at call time. */
export function isStrict(): boolean {
  return envFlag('WRAP_ESM_LAMBDA_STRICT')
}

/**
 * Debug tracing, bound once: unlike the other two this is consulted per
 * matched module, and the whole point of the runtime shell is that a matched
 * module costs microseconds.
 */
export const DEBUG = envFlag('WRAP_ESM_LAMBDA_DEBUG')

/** A failure the shells recovered from, in the order they happened. */
export interface RecoveredFailure {
  what: string
  error: unknown
}

const warned = new Set<string>()
const failures: RecoveredFailure[] = []
const FAILURE_LOG_LIMIT = 50
let failureCount = 0

function write(message: string): void {
  // stderr directly, not console: a patched console is exactly the kind of
  // thing instrumentation does, and a report about instrumentation failing
  // should not travel through it
  process.stderr.write(`wrap-esm-lambda: ${message}\n`)
}

/** Trace a decision when WRAP_ESM_LAMBDA_DEBUG is set. */
export function debug(message: string): void {
  if (DEBUG) write(message)
}

/** Warn about `key` once per process, however many times it recurs. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  write(message)
}

/**
 * Report a failure that has a degraded path behind it and continue — unless
 * strict mode is on, in which case the original error is rethrown so callers
 * (and the test suite) still see the loud contract.
 *
 * `what` doubles as the warn-once key, so a failure that recurs per module
 * load reports once. Every recovered failure is also recorded for
 * `instrumentationFailures()`.
 *
 * @param what human-readable scope, e.g. `instrumenting <url>`
 * @param err the failure to recover from
 */
export function recover(what: string, err: unknown): void {
  if (isStrict()) throw err
  failureCount += 1
  if (failures.length < FAILURE_LOG_LIMIT) {
    failures.push({ what, error: err })
  }
  const reason = err instanceof Error ? err.message : String(err)
  warnOnce(what, `${what} failed — continuing without it: ${reason} (WRAP_ESM_LAMBDA_STRICT=1 to fail instead)`)
}

/**
 * Every failure recovered from so far — the supportability surface for the
 * question "is this process fully instrumented?". An APM shipping a config
 * can report this after startup instead of guessing. Capped at the first 50
 * entries; `total` counts them all.
 */
export function instrumentationFailures(): { total: number; entries: RecoveredFailure[] } {
  return { total: failureCount, entries: failures.slice() }
}
