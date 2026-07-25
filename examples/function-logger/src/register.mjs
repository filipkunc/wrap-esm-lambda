// The package's own `--import` entry: the app activates the whole
// instrumentation with `node --import example-function-logger/register` —
// no config file, no env var, nothing to copy into the app.
import { registerConfig } from '@wrap-esm-lambda/hooks'
import config from './config.mjs'

await registerConfig(config)
