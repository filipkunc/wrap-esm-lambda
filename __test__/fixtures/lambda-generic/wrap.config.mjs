// A config with no file names and no export names in it: everything about
// the handler is discovered from the Lambda environment (_HANDLER,
// LAMBDA_TASK_ROOT) at preload. Outside Lambda this config is inert.
import { definePatches } from '@wrap-esm-lambda/core'
import { lambdaHandlerEntries } from '@wrap-esm-lambda/hooks/aws-lambda'

export default definePatches(
  [...lambdaHandlerEntries({ patch: { name: 'wrapHandler', from: './patches/wrap.mjs' } })],
  import.meta.url,
)
