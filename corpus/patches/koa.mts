// koa: module.exports IS the Application class — the reserved
// "module.exports" binding hands over the whole slot; prototype mutation
// needs no rebinding.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchKoa(bindings: Record<string, unknown>): void {
  const Application = bindings['module.exports'] as typeof import('koa')
  const orig = Application.prototype.use as unknown as AnyFn
  ;(Application.prototype as unknown as Record<string, AnyFn>).use = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
