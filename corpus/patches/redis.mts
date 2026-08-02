// redis (node-redis): rebind the createClient factory on the transpiled
// CJS entry.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchRedis(bindings: { createClient: AnyFn }): void {
  const orig = bindings.createClient
  bindings.createClient = function createClient(...args) {
    bump()
    return orig.apply(this, args)
  }
}
