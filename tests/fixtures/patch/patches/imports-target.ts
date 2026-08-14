// The dependency footgun, kept as a fixture on purpose: this patch imports
// the very package it instruments. In runtime mode that pulls the target into
// the module cache at preload — BEFORE hooks install — so the app receives
// the cached, unpatched module and the patch silently does nothing.
// @ts-expect-error fixture package is untyped
import { Client as _preloaded } from '@fake/smithy-client'

interface SmithyClient {
  prototype: { send(this: unknown, command: string, ...rest: unknown[]): Promise<string> }
}

export function patchImportsTarget(bindings: { Client: SmithyClient }): void {
  const { Client } = bindings
  const orig = Client.prototype.send
  Client.prototype.send = async function (command: string, ...rest: unknown[]): Promise<string> {
    return `never:${await orig.call(this, command, ...rest)}`
  }
}
