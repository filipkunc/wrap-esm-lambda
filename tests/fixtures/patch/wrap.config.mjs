// JS twin of wrap.config.ts, for the cold-start benchmark (no TypeScript
// stripping involved anywhere in the child process).
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: {
      name: '@fake/smithy-client',
      versionRange: '>=4 <5',
      files: ['dist-es/client.js', 'dist-cjs/index.js'],
    },
    patch: {
      name: 'patchSmithy',
      from: fileURLToPath(new URL('./patches/smithy.mjs', import.meta.url)),
    },
    bindings: ['Client'],
  },
])
