// import-in-the-middle in its synchronous mode (module.registerHooks, in
// thread), patching the same fixture class the exports tap patches — via
// prototype mutation on the namespace iitm hands the Hook callback.
import { register } from 'import-in-the-middle/register-hooks.mjs'
import { Hook } from 'import-in-the-middle'

register({ include: ['@fake/smithy-client'] })

Hook(['@fake/smithy-client'], (exports) => {
  const { Client } = exports
  const orig = Client.prototype.send
  Client.prototype.send = async function (command, ...rest) {
    return `iitm:${await orig.call(this, command, ...rest)}`
  }
})
