import { definePatches } from '@wrap-esm-lambda/core'

// The target is express, not Nest: @nestjs/platform-express serves requests
// through the express instance it creates, and the probe asserts a request
// served through Nest's abstraction still crosses a patch applied to express
// itself — the patch-through claim.
export default definePatches(
  [
    {
      module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
      patch: { name: 'patchExpress', from: '../patches/nestjs-core.mjs' },
      bindings: ['application'],
    },
  ],
  import.meta.url,
)
