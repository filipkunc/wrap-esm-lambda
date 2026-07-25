// `--import` entry: loads the config module named by WRAP_ESM_LAMBDA_CONFIG
// (default export of a `defineConfig(...)` file) and registers the load hook.
// The value is a file path — or a bare package specifier, so an installed
// instrumentation package needs no config file in the app at all:
//
//   WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
//   WRAP_ESM_LAMBDA_CONFIG=@acme/apm/config  node --import @wrap-esm-lambda/hooks/register app.mjs
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerConfig } from './index.mjs'

const configPath = process.env.WRAP_ESM_LAMBDA_CONFIG
if (!configPath) {
  throw new Error(
    '@wrap-esm-lambda/hooks/register: set WRAP_ESM_LAMBDA_CONFIG to your config file path or package specifier',
  )
}

// A path when it looks like one or names an existing file (so the historical
// bare `wrap.config.mjs` keeps meaning ./wrap.config.mjs). Otherwise a
// package specifier — resolved from the app's working directory, exactly
// where Node resolved the `--import` specifier itself. Importing it bare
// from here would instead resolve from the hooks package, which cannot see
// the app's dependencies under pnpm's strict layout.
const isPath = configPath.startsWith('.') || isAbsolute(configPath) || existsSync(configPath)
let configUrl
if (isPath) {
  configUrl = pathToFileURL(configPath).href
} else {
  const requireFromApp = createRequire(join(process.cwd(), 'noop.js'))
  try {
    configUrl = pathToFileURL(requireFromApp.resolve(configPath)).href
  } catch (err) {
    throw new Error(
      `@wrap-esm-lambda/hooks/register: WRAP_ESM_LAMBDA_CONFIG '${configPath}' is neither an existing file nor a package specifier resolvable from ${process.cwd()}`,
      { cause: err },
    )
  }
}
const { default: config } = await import(configUrl)
await registerConfig(config)
