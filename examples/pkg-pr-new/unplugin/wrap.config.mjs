// The declarative half: WHICH package, versions, file and exports to patch.
// Identical to ../runtime/wrap.config.mjs — one config drives both modes.
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
