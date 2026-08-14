// ioredis: tsc-transpiled CJS — the class lives on `exports.default` of
// built/Redis.js. Every command funnels through sendCommand.
import { bump } from './bump.mts'

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

export function patchIoredis({ default: RedisClass }: { default: typeof import('ioredis').Redis }): void {
  const orig = RedisClass.prototype.sendCommand as unknown as AnyFn
  ;(RedisClass.prototype as unknown as Record<string, AnyFn>).sendCommand = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
