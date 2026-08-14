import { definePatches } from '@wrap-esm-lambda/core'

// Both trees of the per-module dual package: whichever one the consumer's
// loader picks, the defining module of `parse` is covered.
export default definePatches(
  [
    {
      module: { name: 'graphql', versionRange: '>=16', files: ['language/parser.js', 'language/parser.mjs'] },
      patch: { name: 'patchGraphql', from: '../patches/graphql.mts' },
      bindings: ['parse'],
    },
  ],
  import.meta.url,
)
