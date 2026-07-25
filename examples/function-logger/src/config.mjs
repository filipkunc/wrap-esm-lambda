// Declares WHAT this package instruments. `from` is relative to this file —
// `import.meta.url` as the second argument resolves it at definition time —
// so the package carries its patch code with it wherever it is installed.
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches(
  [
    {
      module: { name: 'example-quotes', files: ['index.mjs'] },
      patch: { name: 'logCalls', from: './patches/log-calls.mjs' },
      bindings: ['getQuote', 'shout', 'fetchQuote', 'explode'],
    },
  ],
  import.meta.url,
)
