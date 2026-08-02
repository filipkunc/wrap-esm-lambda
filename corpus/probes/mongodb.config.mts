import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'mongodb', versionRange: '>=6', files: ['lib/mongo_client.js'] },
      patch: { name: 'patchMongodb', from: '../patches/mongodb.mts' },
      bindings: ['MongoClient'],
    },
  ],
  import.meta.url,
)
