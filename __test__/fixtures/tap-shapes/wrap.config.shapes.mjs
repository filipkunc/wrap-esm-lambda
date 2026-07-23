// The three export shapes that need the tap's rewrite path: an exported
// const (the canonical Lambda handler), an anonymous default export, and a
// re-export barrel.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

const patches = fileURLToPath(new URL('./patches/shapes.mjs', import.meta.url))

export default definePatches([
  {
    module: { name: '@fake/shapes', versionRange: '>=1 <2', files: ['const.js'] },
    patch: { name: 'patchConstHandler', from: patches },
    bindings: ['handler'],
  },
  {
    module: { name: '@fake/shapes', versionRange: '>=1 <2', files: ['default.js'] },
    patch: { name: 'patchDefault', from: patches },
    bindings: ['default'],
  },
  {
    module: { name: '@fake/shapes', versionRange: '>=1 <2', files: ['barrel.js'] },
    patch: { name: 'patchBarrel', from: patches },
    bindings: ['Inner'],
  },
])
