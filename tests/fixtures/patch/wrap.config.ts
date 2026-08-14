// Fully declarative, fully typed: which package, which version range, which
// files, which exports — and the user code that receives them. The `from`
// specifier is absolute because the import gets injected into the *patched*
// module, wherever that lives on disk.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: {
      name: '@fake/smithy-client',
      versionRange: '>=4 <5',
      // Node loads dist-cjs, bundlers load dist-es — one entry covers both.
      files: ['dist-es/client.js', 'dist-cjs/index.js'],
    },
    patch: {
      name: 'patchSmithy',
      from: fileURLToPath(new URL('./patches/smithy.ts', import.meta.url)),
    },
    bindings: ['Client'],
  },
])
