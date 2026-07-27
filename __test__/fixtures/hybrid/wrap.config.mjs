// The single config both modes consume: the runtime hook via
// WRAP_ESM_LAMBDA_CONFIG, the bundler plugin via a plain import. The handler
// is app code, so the entry matches by path — the suffix rule keeps it
// matching wherever the fixture (or a bundle of it) lands.
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { path: ['hybrid/handler.mjs'] },
      patch: { name: 'wrapHandler', from: './wrap-runtime.mjs' },
      bindings: ['handler'],
    },
  ],
  import.meta.url,
)
