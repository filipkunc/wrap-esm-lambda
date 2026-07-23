// Declares WHAT to patch: express 5's lib/express.js, handing the patch the
// `application` export. The patch path is absolute on purpose — see the
// patch author contract in @wrap-esm-lambda/core's README.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
    patch: { name: 'patchExpressRoute', from: fileURLToPath(new URL('./patches/http-route.mjs', import.meta.url)) },
    bindings: ['application'],
  },
])
