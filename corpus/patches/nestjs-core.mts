// The patch-through probe: Nest is not the target — express UNDERNEATH Nest
// is. The patch is the http-route example's shape (wrap application.handle),
// and the probe asserts a request served through Nest's abstraction still
// crosses it.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchExpress({ application }: { application: Record<string, AnyFn> }): void {
  const orig = application.handle!
  application.handle = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
