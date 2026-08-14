// The user patch for the real AWS SDK: every @aws-sdk/client-* operation
// funnels through Client#send in @smithy/core's client submodule, so one
// prototype patch intercepts the entire SDK. Here it short-circuits before
// the middleware stack — no credentials resolution, no network.
interface SmithyClientClass {
  prototype: { send(this: unknown, command: unknown, ...rest: unknown[]): Promise<unknown> }
}

export function patchSmithyClient(bindings: { Client: SmithyClientClass }): void {
  const { Client } = bindings
  Client.prototype.send = async function (command: unknown): Promise<unknown> {
    const name = (command as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'
    return { $metadata: {}, __intercepted: name }
  }
}
