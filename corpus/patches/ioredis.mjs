// ioredis: tsc-transpiled CJS — the class lives on `exports.default` of
// built/Redis.js. Every command funnels through sendCommand.
const bump = () => {
  const k = Symbol.for('wrap-esm-lambda-corpus.probe')
  globalThis[k] = (globalThis[k] ?? 0) + 1
}

export function patchIoredis({ default: Redis }) {
  const orig = Redis.prototype.sendCommand
  Redis.prototype.sendCommand = function (...args) {
    bump()
    return orig.apply(this, args)
  }
}
