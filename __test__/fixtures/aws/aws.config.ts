// One declarative entry instruments the entire AWS SDK v3: every client's
// send() comes from @smithy/core's client submodule. Node loads the bundled
// dist-cjs, bundlers load dist-es (where the barrel re-exports mean the tap
// must target the defining file, not the index) — one entry names both.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: {
      name: '@smithy/core',
      versionRange: '>=3 <5',
      files: ['dist-es/submodules/client/smithy-client/client.js', 'dist-cjs/submodules/client/index.js'],
    },
    patch: {
      name: 'patchSmithyClient',
      from: fileURLToPath(new URL('./patches/aws.ts', import.meta.url)),
    },
    bindings: ['Client'],
  },
])
