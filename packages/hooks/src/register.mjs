// `--import` entry: loads the config module named by WRAP_ESM_LAMBDA_CONFIG
// (default export of a `defineConfig(...)` file) and registers the load hook.
//
//   WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
import { pathToFileURL } from 'node:url'
import { registerConfig } from './index.mjs'

const configPath = process.env.WRAP_ESM_LAMBDA_CONFIG
if (!configPath) {
  throw new Error('@wrap-esm-lambda/hooks/register: set WRAP_ESM_LAMBDA_CONFIG to your config file path')
}

const { default: config } = await import(pathToFileURL(configPath).href)
await registerConfig(config)
