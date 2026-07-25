// The patch function itself throws. The tap calls it from the patched
// module's own body, so without containment this is a module load failure.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: { name: '@fake/smithy-client', versionRange: '>=4 <5', files: ['dist-cjs/index.js'] },
    patch: { name: 'patchThatThrows', from: fileURLToPath(new URL('./patches/throws.mjs', import.meta.url)) },
    bindings: ['Client'],
  },
])
