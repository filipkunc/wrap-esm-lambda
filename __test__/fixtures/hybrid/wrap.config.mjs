// The single config both modes consume: the runtime hook via
// WRAP_ESM_LAMBDA_CONFIG, the bundler plugin via a plain import.
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@wrap-esm-lambda/core'

export default defineConfig({
  entries: [
    {
      match: 'hybrid/handler.mjs',
      handler: 'handler',
      wrapper: {
        name: 'WrapAwsLambda',
        from: fileURLToPath(new URL('./wrap-runtime.mjs', import.meta.url)),
      },
    },
  ],
})
