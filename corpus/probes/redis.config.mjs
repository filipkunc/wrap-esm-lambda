import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'redis', versionRange: '>=4', files: ['dist/index.js'] },
      patch: { name: 'patchRedis', from: '../patches/redis.mjs' },
      bindings: ['createClient'],
    },
  ],
  import.meta.url,
)
