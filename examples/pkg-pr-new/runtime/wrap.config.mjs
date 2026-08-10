// The declarative half: WHICH package, versions, file and exports to patch.
// `from` resolves relative to this file via the `import.meta.url` argument.
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
      patch: { name: 'logRequests', from: './patches/log-requests.mjs' },
      bindings: ['application'],
    },
  ],
  import.meta.url,
)
