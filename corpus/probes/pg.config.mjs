import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'pg', versionRange: '>=8', files: ['lib/index.js'] },
      patch: { name: 'patchPg', from: '../patches/pg.mjs' },
      bindings: ['Client'],
    },
  ],
  import.meta.url,
)
