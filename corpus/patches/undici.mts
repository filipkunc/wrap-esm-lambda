// undici: rebinding a plain function export on handwritten CJS — the tap's
// verified setter guarantees the write took (no sloppy-mode silent no-op).
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchUndici(bindings: { request: AnyFn }): void {
  const orig = bindings.request
  bindings.request = function request(...args) {
    bump()
    return orig.apply(this, args)
  }
}
