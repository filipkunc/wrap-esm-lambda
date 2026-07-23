// Deliberately wrong: points the rebind patch at hono's bundled CJS build,
// whose exports are non-configurable getters in sloppy mode — assignment
// would silently no-op, so the tap's verified setter must throw instead.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

const patches = fileURLToPath(new URL('./patches/frameworks.mjs', import.meta.url))

export default definePatches([
  {
    module: { name: 'hono', versionRange: '>=4 <5', files: ['dist/cjs/index.js'] },
    patch: { name: 'patchHonoRebind', from: patches },
    bindings: ['Hono'],
  },
])
