// A user patch: plain imperative TypeScript against live objects — the same
// mental model as Module._load-era monkey-patching, minus the loader.
interface SmithyClient {
  prototype: { send(this: unknown, command: string, ...rest: unknown[]): Promise<string> }
}

export function patchSmithy(bindings: { Client: SmithyClient }): void {
  const { Client } = bindings
  const orig = Client.prototype.send
  Client.prototype.send = async function (command: string, ...rest: unknown[]): Promise<string> {
    return `patched:${await orig.call(this, command, ...rest)}`
  }
}
