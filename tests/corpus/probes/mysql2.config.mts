import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'mysql2', versionRange: '>=3', files: ['index.js'] },
      patch: { name: 'patchMysql2', from: '../patches/mysql2.mts' },
      bindings: ['createPool'],
    },
  ],
  import.meta.url,
)
