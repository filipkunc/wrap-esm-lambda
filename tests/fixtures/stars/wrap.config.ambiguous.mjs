import { definePatches } from '@wrap-esm-lambda/core'

// `clash` reaches the barrel through both star sources as two DIFFERENT
// local declarations — genuinely ambiguous. The validator must surface the
// star walk's refusal (which names both origins), not collapse it into a
// plain "not exported".
export default definePatches(
  [
    {
      module: { name: '@fake/stars', files: ['barrel.js'] },
      patch: { name: 'patchShared', from: './patches/stars.mjs' },
      bindings: ['clash'],
    },
  ],
  import.meta.url,
)
