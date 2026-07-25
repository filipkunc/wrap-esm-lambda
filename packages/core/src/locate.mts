// Turning what a user writes — in WRAP_ESM_LAMBDA_CONFIG or on the validator's
// command line — into a URL that can be imported. One rule, shared by the
// runtime shell's `--import` entry and the validator, because a config that
// resolves for one and not the other is a trap: instrumentation would validate
// clean and then never load (or the reverse).
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolve a config file path or package specifier to an importable URL.
 *
 * A path when it looks like one or names an existing file (so a bare
 * `wrap.config.mjs` keeps meaning `./wrap.config.mjs`). Otherwise a package
 * specifier — resolved from the app's working directory, exactly where Node
 * resolved the `--import` specifier itself. Resolving it from this package
 * instead would look in the wrong place entirely: under pnpm's strict layout
 * the toolkit cannot see the app's dependencies.
 *
 * @param what prefix for the error message, naming the caller the user invoked
 * @param cwd the directory a bare specifier resolves from
 */
export function resolveConfigUrl(value: string, what: string, cwd: string = process.cwd()): string {
  const isPath = value.startsWith('.') || isAbsolute(value) || existsSync(value)
  if (isPath) {
    return pathToFileURL(value).href
  }
  const requireFromApp = createRequire(join(cwd, 'noop.js'))
  try {
    return pathToFileURL(requireFromApp.resolve(value)).href
  } catch (err) {
    throw new Error(`${what}: '${value}' is neither an existing file nor a package specifier resolvable from ${cwd}`, {
      cause: err,
    })
  }
}
