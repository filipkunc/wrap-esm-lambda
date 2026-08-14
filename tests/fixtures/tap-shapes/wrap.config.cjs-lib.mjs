// The pure-CJS build-time target: a `.js` main in a package without `"type"`.
// Nothing but the source's own (absent) module syntax says CJS here.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: { name: '@fake/cjs-lib', versionRange: '>=1 <2', files: ['index.js'] },
    patch: { name: 'patchCjsGreet', from: fileURLToPath(new URL('./patches/cjs-lib.mjs', import.meta.url)) },
    bindings: ['greet'],
  },
])
