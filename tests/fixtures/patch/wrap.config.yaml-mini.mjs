import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

// The matched module is assembled by cjs-minified-map.spec.ts in a tmpdir:
// a package named yaml-mini whose main is the REAL js-yaml dist/js-yaml.min.js
// (single-line minified bundle) with its shipped external source map beside it.
export default definePatches([
  {
    module: { name: 'yaml-mini', versionRange: '>=4 <5', files: ['js-yaml.min.js'] },
    patch: {
      name: 'patchYamlMini',
      from: fileURLToPath(new URL('./patches/yaml-mini.mjs', import.meta.url)),
    },
    bindings: ['load'],
  },
])
