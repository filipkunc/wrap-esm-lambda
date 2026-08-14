// pg: prototype mutation on the exported Client class — the bread-and-butter
// path. `query` is what every OTel pg instrumentation wraps.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchPg({ Client }: { Client: typeof import('pg').Client }): void {
  const orig = Client.prototype.query as unknown as AnyFn
  ;(Client.prototype as unknown as Record<string, AnyFn>).query = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
