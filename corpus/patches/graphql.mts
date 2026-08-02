// graphql: rebinding a function export at its DEFINING module
// (language/parser), so the patch propagates through the package's
// re-export chain to every import route via ESM live bindings.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchGraphql(bindings: { parse: AnyFn }): void {
  const orig = bindings.parse
  bindings.parse = function parse(...args) {
    bump()
    return orig.apply(this, args)
  }
}
