import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'ioredis', versionRange: '>=5', files: ['built/Redis.js'] },
      patch: { name: 'patchIoredis', from: '../patches/ioredis.mjs' },
      bindings: ['default'],
    },
  ],
  import.meta.url,
)
