#!/usr/bin/env node
// `wrap-esm-lambda-validate` — check a config against the installed tree.
//
//   wrap-esm-lambda-validate                    # WRAP_ESM_LAMBDA_CONFIG
//   wrap-esm-lambda-validate ./wrap.config.mjs  # a path
//   wrap-esm-lambda-validate @acme/apm/config   # or a package specifier
//   wrap-esm-lambda-validate --json             # machine-readable
//
// Exits 1 when any entry reports an error, so it works as a CI gate: the
// runtime shell degrades quietly by design, and this is where that design's
// blind spot — nobody notices — gets covered while failing is still cheap.
import { resolveConfigUrl } from './locate.mjs'
import { formatReport, validateConfig } from './validate.mjs'
import type { InstrumentConfig } from './config.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const positional = args.filter((arg) => !arg.startsWith('-'))
const target = positional[0] ?? process.env.WRAP_ESM_LAMBDA_CONFIG

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'usage: wrap-esm-lambda-validate [config path or package specifier] [--json]\n' +
      '       falls back to WRAP_ESM_LAMBDA_CONFIG\n',
  )
  process.exit(0)
}

if (!target) {
  process.stderr.write(
    'wrap-esm-lambda-validate: pass a config path or package specifier, or set WRAP_ESM_LAMBDA_CONFIG\n',
  )
  process.exit(2)
}

const cwd = process.cwd()
let config: InstrumentConfig
try {
  const url = resolveConfigUrl(target, 'wrap-esm-lambda-validate', cwd)
  config = ((await import(url)) as { default: InstrumentConfig }).default
} catch (err) {
  // an unreadable config is exit 2, not 1: nothing was validated, which is a
  // different outcome from "validated and found broken"
  process.stderr.write(`wrap-esm-lambda-validate: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
}

if (config === undefined || !Array.isArray(config.entries)) {
  process.stderr.write(`wrap-esm-lambda-validate: ${target} has no default-exported config with an 'entries' array\n`)
  process.exit(2)
}

const report = await validateConfig(config, { cwd })
process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report, cwd)}\n`)
process.exit(report.ok ? 0 : 1)
