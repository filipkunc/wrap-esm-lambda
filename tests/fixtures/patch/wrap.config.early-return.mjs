import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: { name: '@fake/early-return', versionRange: '>=1 <2', files: ['index.js'] },
    patch: {
      name: 'patchEarlyReturn',
      from: fileURLToPath(new URL('./patches/early-return.mjs', import.meta.url)),
    },
    bindings: ['greet'],
  },
])
