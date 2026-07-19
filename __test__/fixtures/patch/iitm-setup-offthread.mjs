// import-in-the-middle in its classic off-thread mode (module.register, the
// OTel/dd-trace default today): the loader runs on a separate thread and each
// resolved module pays an IPC round-trip.
import { register } from 'node:module'
import { createAddHookMessageChannel, Hook } from 'import-in-the-middle'

const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel()
register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions)

Hook(['@fake/smithy-client'], (exports) => {
  const { Client } = exports
  const orig = Client.prototype.send
  Client.prototype.send = async function (command, ...rest) {
    return `iitm:${await orig.call(this, command, ...rest)}`
  }
})

await waitForAllMessagesAcknowledged()
