// Taps names that only exist behind bare-specifier `export * from` — the
// walk must resolve the packages (exports map / module field) to attribute
// each name before the tap can shadow it.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

const patches = fileURLToPath(new URL('./patches/star-bare.mjs', import.meta.url))

export default definePatches([
  {
    module: { name: '@fake/shapes', versionRange: '>=1 <2', files: ['star-bare.js'] },
    patch: { name: 'patchStarPkg', from: patches },
    bindings: ['StarPkg'],
  },
  {
    module: { name: '@fake/shapes', versionRange: '>=1 <2', files: ['star-bare.js'] },
    patch: { name: 'patchStarPlain', from: patches },
    bindings: ['plainGreet'],
  },
])
