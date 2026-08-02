import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'koa', versionRange: '>=2', files: ['lib/application.js'] },
      patch: { name: 'patchKoa', from: '../patches/koa.mts' },
      bindings: ['module.exports'],
    },
  ],
  import.meta.url,
)
