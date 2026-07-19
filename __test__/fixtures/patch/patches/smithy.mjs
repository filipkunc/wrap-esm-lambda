// JS twin of smithy.ts: used by the cold-start benchmark to separate the
// exports-tap mechanism cost from Node's TypeScript-stripping toolchain init,
// which dominates when the config/patch are .ts.
export function patchSmithy(bindings) {
  const { Client } = bindings
  const orig = Client.prototype.send
  Client.prototype.send = async function (command, ...rest) {
    return `patched:${await orig.call(this, command, ...rest)}`
  }
}
