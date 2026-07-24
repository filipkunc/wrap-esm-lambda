// Small shims over node:assert for the one ava ergonomic node:test lacks:
// capturing the thrown/rejected error for further assertions (ava's
// t.throws / t.throwsAsync returned it; assert.throws does not).
import assert from 'node:assert/strict'

/** Run `fn`, assert it throws, and hand the error back for inspection. */
export function captureThrows(fn: () => unknown): Error {
  try {
    fn()
  } catch (err) {
    return err as Error
  }
  assert.fail('expected the call to throw')
}

/** Await `fn`, assert it rejects, and hand the rejection back for inspection. */
export async function captureRejects<E = Error>(fn: () => Promise<unknown>): Promise<E> {
  try {
    await fn()
  } catch (err) {
    return err as E
  }
  assert.fail('expected the promise to reject')
}
