// The declarative half: WHICH package, versions, file and exports to patch.
// `dist/hono.js` is where the Hono class is DEFINED — target the defining
// module, not the `dist/index.js` barrel that merely re-exports it, so the
// patch stays on the append-only fast path and lands for consumers that
// bypass the barrel. `from` resolves relative to this file via the
// `import.meta.url` argument.
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'hono', versionRange: '>=4 <5', files: ['dist/hono.js'] },
      patch: { name: 'logRequests', from: './patches/log-requests.mjs' },
      bindings: ['Hono'],
    },
  ],
  import.meta.url,
)
