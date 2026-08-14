// mysql2: rebind a named factory export on handwritten CJS.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchMysql2(bindings: { createPool: AnyFn }): void {
  const orig = bindings.createPool
  bindings.createPool = function createPool(...args) {
    bump()
    return orig.apply(this, args)
  }
}
