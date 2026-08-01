import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'undici', versionRange: '>=7', files: ['index.js'] },
      patch: { name: 'patchUndici', from: '../patches/undici.mjs' },
      bindings: ['request'],
    },
  ],
  import.meta.url,
)
