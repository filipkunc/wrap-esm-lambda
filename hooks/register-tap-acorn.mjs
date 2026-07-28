// The pure-JS engine's cold start: identical to register-tap-oxc.mjs except
// the engine pin — the difference between the two rows is the acorn module
// graph replacing the native addon's dlopen.
import { fileURLToPath } from 'node:url'

process.env.WRAP_ESM_LAMBDA_CONFIG = fileURLToPath(new URL('./wrap.config.mjs', import.meta.url))
process.env.WRAP_ESM_LAMBDA_ENGINE = 'acorn'
await import('@wrap-esm-lambda/hooks/register')
