// One-file activation for the cold-start benchmark: same command shape as
// the other --import entries, env set here so hyperfine's command string and
// /usr/bin/time's "Command being timed" stay identical (update-bench-table
// matches rows by that string).
import { fileURLToPath } from 'node:url'

process.env.WRAP_ESM_LAMBDA_CONFIG = fileURLToPath(new URL('./wrap.config.mjs', import.meta.url))
process.env.WRAP_ESM_LAMBDA_ENGINE = 'oxc'
await import('@wrap-esm-lambda/hooks/register')
