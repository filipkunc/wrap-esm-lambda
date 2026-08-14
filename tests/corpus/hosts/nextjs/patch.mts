// The host harness patch: wrap the `ms` factory (bare module.exports = fn —
// the reserved "module.exports" binding) so every server-side call through
// Next's externalized require bumps the probe counter the SSR page renders.
import { bump } from '../../patches/bump.mts'

type MsFn = (this: unknown, ...args: unknown[]) => unknown

export function patchMs(bindings: Record<string, unknown>): void {
  const orig = bindings['module.exports'] as MsFn
  bindings['module.exports'] = function ms(this: unknown, ...args: unknown[]): unknown {
    bump()
    return orig.apply(this, args)
  }
}
