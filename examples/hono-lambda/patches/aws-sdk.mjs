// Every @aws-sdk/client-* operation funnels through Client#send in
// @smithy/core's client submodule, so one prototype patch sees the entire
// SDK. Here it logs the operation and short-circuits BEFORE the middleware
// stack builds — no credential resolution, no network — which is also the
// whole testing story: the interception point that instruments the SDK is
// the same one that makes a LocalStack unnecessary. A forwarding APM patch
// would keep the original send and `return await original.call(this,
// command, ...rest)` inside the timed section instead of returning a stub.
export function patchSmithyClient(bindings) {
  bindings.Client.prototype.send = async function (command) {
    console.log(`aws.operation = ${command?.constructor?.name ?? 'unknown'}`)
    return { $metadata: { httpStatusCode: 200 } }
  }
}
