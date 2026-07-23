// The export shapes that need the tap's rewrite path: an exported const
// (the canonical Lambda handler), an anonymous default export, a re-export
// barrel, a destructured const export, and a namespace re-export.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

const patches = fileURLToPath(new URL('./patches/shapes.mjs', import.meta.url))
const entry = (file, name, bindings) => ({
  module: { name: '@fake/shapes', versionRange: '>=1 <2', files: [file] },
  patch: { name, from: patches },
  bindings,
})

export default definePatches([
  entry('const.js', 'patchConstHandler', ['handler']),
  entry('default.js', 'patchDefault', ['default']),
  entry('barrel.js', 'patchBarrel', ['Inner']),
  entry('destructured.js', 'patchDestructured', ['greet']),
  entry('ns.js', 'patchNs', ['inner']),
])
