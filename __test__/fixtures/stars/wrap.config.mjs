import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: '@fake/stars', files: ['barrel.js'] },
      patch: { name: 'patchShared', from: './patches/stars.mjs' },
      bindings: ['shared'],
    },
  ],
  import.meta.url,
)
