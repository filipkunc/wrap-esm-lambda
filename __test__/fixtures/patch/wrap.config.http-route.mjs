// http.route capture across the three framework shapes — the OTel-contrib
// work, expressed as three declarative entries.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

const patches = fileURLToPath(new URL('./patches/http-route.mjs', import.meta.url))

export default definePatches([
  {
    module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
    patch: { name: 'patchExpressRoute', from: patches },
    bindings: ['application'],
  },
  {
    module: { name: 'fastify', versionRange: '>=5 <6', files: ['fastify.js'] },
    patch: { name: 'patchFastifyRoute', from: patches },
    bindings: ['module.exports'],
  },
  {
    // ESM build only: auto-installing the middleware rebinds Hono to a
    // subclass, which the bundled CJS getter-only exports cannot support —
    // a require()d hono keeps working, just without route capture.
    module: { name: 'hono', versionRange: '>=4 <5', files: ['dist/hono.js'] },
    patch: { name: 'patchHonoHttpRoute', from: patches },
    bindings: ['Hono'],
  },
])
