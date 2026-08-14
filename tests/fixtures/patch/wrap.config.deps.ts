// Same matcher as wrap.config.ts, but the patch carries its own dependency
// graph (relative TS helper + bare npm specifier).
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
      name: 'patchWithDeps',
      from: fileURLToPath(new URL('./patches/with-deps.ts', import.meta.url)),
    },
    bindings: ['Client'],
  },
])
