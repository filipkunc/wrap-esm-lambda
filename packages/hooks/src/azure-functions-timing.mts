// Async-outcome observation, the generic piece under the bracket: run a
// callback that may return a value, return a thenable, or throw, pass its
// outcome through untouched, and report when (and how) it completed. Both
// of the preset's wrappers — foreign-hook timing and callback bracketing —
// are this one shape with different completion handlers; nothing in this
// file knows anything about Azure.

export const now = (): number => Number(process.hrtime.bigint()) / 1e6

export const isThenable = (value: unknown): value is Promise<unknown> =>
  value !== null && typeof value === 'object' && typeof (value as Promise<unknown>).then === 'function'

/** How an observed callback ended: a value returned, or an error thrown. */
export type CallbackOutcome = { threw: false; value: unknown } | { threw: true; error: unknown }

/**
 * Run `fn` and hand `done` the completion time and outcome — after the
 * settle for a thenable, at return/throw otherwise — without changing what
 * the caller observes: the value, the rejection, and the throw all pass
 * through exactly as `fn` produced them.
 */
export function observeCompletion(fn: () => unknown, done: (at: number, outcome: CallbackOutcome) => void): unknown {
  try {
    const out = fn()
    if (isThenable(out)) {
      return out.then(
        (value) => {
          done(now(), { threw: false, value })
          return value
        },
        (err: unknown) => {
          done(now(), { threw: true, error: err })
          throw err
        },
      )
    }
    done(now(), { threw: false, value: out })
    return out
  } catch (err) {
    done(now(), { threw: true, error: err })
    throw err
  }
}
