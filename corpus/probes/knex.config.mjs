import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'knex', versionRange: '>=3', files: ['knex.js'] },
      patch: { name: 'patchKnex', from: '../patches/knex.mjs' },
      bindings: ['module.exports'],
    },
  ],
  import.meta.url,
)
