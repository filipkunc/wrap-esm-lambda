// knex: module.exports is the factory function AND self-references
// (knex.knex = knex, knex.default = knex) — rebinding the callable means
// rebinding its aliases with it, the ordinary monkey-patch duty the patch
// author contract calls out (fastify has the same shape).
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchKnex(bindings) {
  const orig = bindings['module.exports']
  const wrapped = function knex(...args) {
    bump()
    return orig.apply(this, args)
  }
  Object.assign(wrapped, orig)
  wrapped.knex = wrapped
  wrapped.default = wrapped
  bindings['module.exports'] = wrapped
}
