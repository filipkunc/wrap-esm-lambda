// Real-package entries, one per shape: pure-CJS express, module.exports-is-
// the-API fastify, and dual-package hono. For hono the ESM side targets the
// DEFINING module (dist/hono.js) — the dist/index.js barrel only re-exports,
// and re-exports have no local binding to tap.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

const patches = fileURLToPath(new URL('./patches/frameworks.mjs', import.meta.url))

export default definePatches([
  {
    module: { name: 'express', versionRange: '>=5 <6', files: ['lib/express.js'] },
    patch: { name: 'patchExpressJson', from: patches },
    bindings: ['json'],
  },
  {
    module: { name: 'fastify', versionRange: '>=5 <6', files: ['fastify.js'] },
    patch: { name: 'patchFastifyFactory', from: patches },
    bindings: ['module.exports'],
  },
  {
    // mutation: works on both builds — one entry, both dist trees
    module: { name: 'hono', versionRange: '>=4 <5', files: ['dist/hono.js', 'dist/cjs/index.js'] },
    patch: { name: 'patchHonoRoute', from: patches },
    bindings: ['Hono'],
  },
  {
    // rebind (class-field interception needs a subclass): ESM build only —
    // the bundled CJS getters cannot be rebound, and the tap throws rather
    // than silently no-op if pointed at them
    module: { name: 'hono', versionRange: '>=4 <5', files: ['dist/hono.js'] },
    patch: { name: 'patchHonoRebind', from: patches },
    bindings: ['Hono'],
  },
])
