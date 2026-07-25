// Declares WHAT to patch: express 5's lib/express.js, handing the patch the
// `application` export. `from` is relative to this file — `import.meta.url`
// as the second argument resolves it to an absolute path at definition time
// (the resolution rules live in @wrap-esm-lambda/core's patch author
// contract).
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
      patch: { name: 'patchExpressRoute', from: './patches/http-route.mjs' },
      bindings: ['application'],
    },
  ],
  import.meta.url,
)
