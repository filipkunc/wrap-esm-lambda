// knex: module.exports is the factory function AND self-references
// (knex.knex = knex, knex.default = knex) — rebinding the callable means
// rebinding its aliases with it, the ordinary monkey-patch duty the patch
// author contract calls out (fastify has the same shape).
import { bump } from './bump.mts'

type KnexFactory = ((this: unknown, ...args: unknown[]) => unknown) & Record<string, unknown>

export function patchKnex(bindings: Record<string, unknown>): void {
  const orig = bindings['module.exports'] as KnexFactory
  const wrapped = function knex(this: unknown, ...args: unknown[]): unknown {
    bump()
    return orig.apply(this, args)
  } as KnexFactory
  Object.assign(wrapped, orig)
  wrapped.knex = wrapped
  wrapped.default = wrapped
  bindings['module.exports'] = wrapped
}
