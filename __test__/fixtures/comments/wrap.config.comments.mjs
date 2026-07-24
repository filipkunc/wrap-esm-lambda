import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: { name: '@fake/comments', versionRange: '>=1 <2', files: ['lib.js'] },
    patch: { name: 'patchConstHandler', from: fileURLToPath(new URL('./patches/comments.mjs', import.meta.url)) },
    bindings: ['handler'],
  },
])
