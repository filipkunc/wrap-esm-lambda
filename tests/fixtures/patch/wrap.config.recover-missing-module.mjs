// Two entries on the same module, one of them undeliverable: the patch file
// does not exist. The broken entry must drop out at preload and the good one
// must still apply — partial degradation, not an all-or-nothing config.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

const module = { name: '@fake/smithy-client', versionRange: '>=4 <5', files: ['dist-cjs/index.js'] }

export default definePatches([
  {
    module,
    patch: { name: 'patchMissing', from: fileURLToPath(new URL('./patches/does-not-exist.mjs', import.meta.url)) },
    bindings: ['Client'],
  },
  {
    module,
    patch: { name: 'patchSmithy', from: fileURLToPath(new URL('./patches/smithy.mjs', import.meta.url)) },
    bindings: ['Client'],
  },
])
