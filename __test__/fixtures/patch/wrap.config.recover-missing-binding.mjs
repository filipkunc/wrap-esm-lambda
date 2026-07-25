// The version-drift shape: the config asks hono's real ESM build for an
// export it does not have — the shape of a binding renamed in a dependency
// bump. The transform throws (ESM exports are validated statically); the
// module must still load, untouched.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: { name: 'hono', versionRange: '>=4 <5', files: ['dist/hono.js'] },
    patch: { name: 'patchHonoRoute', from: fileURLToPath(new URL('./patches/frameworks.mjs', import.meta.url)) },
    bindings: ['HonoRenamedInV5'],
  },
])
