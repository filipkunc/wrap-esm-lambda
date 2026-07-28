// The cold-start benchmark's config: one path-matched entry wrapping the
// fixture handler through the generic exports tap.
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { path: ['hooks/handler.mjs'] },
      patch: { name: 'wrapHandler', from: './patch-wrap.mjs' },
      bindings: ['handler'],
    },
  ],
  import.meta.url,
)
