import { definePatches } from '@wrap-esm-lambda/core'

// Next.js as a HOST: the config targets an ordinary server-side dependency
// (ms), never Next itself — Next owns its module graph and is exercised as
// the platform the hook rides inside, via NODE_OPTIONS preload on
// `next start` and `next dev` alike (both fork workers; NODE_OPTIONS
// reaches every one of them, which is why it is the right delivery here —
// the same reason it is on Lambda and Azure Functions).
export default definePatches(
  [
    {
      module: { name: 'ms', versionRange: '>=2', files: ['index.js'] },
      patch: { name: 'patchMs', from: './patch.mts' },
      bindings: ['module.exports'],
    },
  ],
  import.meta.url,
)
