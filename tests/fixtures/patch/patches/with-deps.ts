// A patch with real dependencies: a relative TypeScript helper and a bare npm
// specifier (chalk, ESM, resolves from this file's location up to the app's
// node_modules; without a TTY it passes strings through unchanged, keeping
// the assertion deterministic). Runtime mode imports this graph at preload;
// build mode bundles it into the artifact.
import chalk from 'chalk'
import { exclaim } from './helper.ts'

interface SmithyClient {
  prototype: { send(this: unknown, command: string, ...rest: unknown[]): Promise<string> }
}

export function patchWithDeps(bindings: { Client: SmithyClient }): void {
  const { Client } = bindings
  const orig = Client.prototype.send
  Client.prototype.send = async function (command: string, ...rest: unknown[]): Promise<string> {
    return `deps:${exclaim(chalk.red(await orig.call(this, command, ...rest)))}`
  }
}
