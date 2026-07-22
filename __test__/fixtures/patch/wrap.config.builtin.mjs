// Builtin patch target: no files, versionRange gates on the running Node.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: {
      name: 'node:os',
      versionRange: '>=22',
    },
    patch: {
      name: 'patchOs',
      from: fileURLToPath(new URL('./patches/os.mjs', import.meta.url)),
    },
    bindings: ['hostname'],
  },
])
