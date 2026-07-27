// AWS Lambda preset: derive the patch entry for the function's own handler
// from what the platform tells its runtime interface client. On Lambda the
// handler's file and export name are not knowable when a config is written —
// they arrive at runtime as `_HANDLER` (e.g. `src/index.handler`) and
// `LAMBDA_TASK_ROOT`. A config is code evaluated in the target process at
// preload, before the RIC's late handler import, so this preset reads them
// there and emits an ordinary, fully static path-matched entry — the generic
// exports tap does the rest (an `export const handler` goes through the
// rewrite path; a CJS handler is a `module.exports` property tap).
//
// The parsing and lookup below reproduce the RIC's own rules
// (aws/aws-lambda-nodejs-runtime-interface-client, UserFunction):
// - the module root is everything before the handler string's basename;
// - the basename splits on the FIRST dot: module name, then a (possibly
//   nested) property path whose first segment is the exported binding;
// - the module resolves as `resolve(taskRoot, moduleRoot, moduleName)` with
//   extension lookup order '', '.js', '.mjs', '.cjs'.
// Every existing candidate becomes a match path; only the file the RIC
// actually loads is ever instrumented, so replicating its precedence is
// unnecessary. Not covered: the RIC's final `require.resolve` fallback for
// handlers that live in node_modules — those have package identity, which is
// what ordinary `module: { name }` entries are for.
import { basename, resolve } from 'node:path'
import { debug, recover } from '@wrap-esm-lambda/core'
import type { PatchEntry, PatchSpec } from '@wrap-esm-lambda/core'

/** The RIC's split of a handler basename: module name, then property path. */
const FUNCTION_EXPR = /^([^.]*)\.(.*)$/

/** The RIC's module lookup order (yes, extensionless first). */
const EXTENSIONS = ['', '.js', '.mjs', '.cjs']

export interface LambdaHandlerOptions {
  /** the patch function the tapped handler binding is handed to */
  patch: PatchSpec
  /** handler string override; defaults to `process.env._HANDLER` */
  handler?: string
  /** app root override; defaults to `process.env.LAMBDA_TASK_ROOT` */
  taskRoot?: string
}

/**
 * The patch entries instrumenting this Lambda function's handler — one
 * path-matched entry, or none when the environment carries no handler (the
 * config is then running outside Lambda, and a config that is inert there is
 * the correct shape for one package shipping both). Malformed handler
 * strings — no dot, a `..` segment — are reported through the failure log
 * (throwing under WRAP_ESM_LAMBDA_STRICT=1) and yield no entry; the RIC
 * itself will refuse the same string moments later, more loudly.
 *
 * Spread the result into `definePatches` next to ordinary package entries:
 *
 * ```js
 * export default definePatches(
 *   [...lambdaHandlerEntries({ patch: { name: 'wrapHandler', from: './patches/lambda.mjs' } })],
 *   import.meta.url,
 * )
 * ```
 */
export function lambdaHandlerEntries(options: LambdaHandlerOptions): PatchEntry[] {
  const handlerString = options.handler ?? process.env._HANDLER
  const taskRoot = options.taskRoot ?? process.env.LAMBDA_TASK_ROOT
  if (handlerString === undefined || taskRoot === undefined) {
    debug('aws-lambda preset: no _HANDLER/LAMBDA_TASK_ROOT in the environment — no entry')
    return []
  }
  if (handlerString.includes('..')) {
    recover(
      `aws-lambda preset: handler '${handlerString}'`,
      new TypeError('relative path segments are not allowed in handler names (the RIC rejects them too)'),
    )
    return []
  }
  const handlerBase = basename(handlerString)
  const moduleRoot = handlerString.slice(0, handlerString.indexOf(handlerBase))
  const match = handlerBase.match(FUNCTION_EXPR)
  if (!match) {
    recover(
      `aws-lambda preset: handler '${handlerString}'`,
      new TypeError("expected the RIC's 'file.method' shape (a dot separating module and export)"),
    )
    return []
  }
  const [, moduleName, propertyPath] = match as unknown as [string, string, string]
  const prefix = resolve(taskRoot, moduleRoot, moduleName)
  // the exported binding is the property path's first segment: for a nested
  // `index.api.handler` the tap hands the patch the exported `api` object,
  // and the patch walks the rest imperatively
  const binding = propertyPath.split('.', 1)[0]!
  return [
    {
      module: { path: EXTENSIONS.map((extension) => prefix + extension) },
      patch: options.patch,
      bindings: [binding],
    },
  ]
}
