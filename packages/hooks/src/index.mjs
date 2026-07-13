// Runtime shell of the hybrid setup: wraps matched modules as they load, via
// Node's synchronous `module.registerHooks`. Zero build-pipeline changes —
// activate with `node --import @wrap-esm-lambda/hooks/register app.mjs` (config
// path in WRAP_ESM_LAMBDA_CONFIG) or call `registerConfig(config)` yourself.
// The transform is the same native call the build-time shell runs, so the cold
// start cost is microseconds per matched module.
import { registerHooks } from 'node:module'
import { createMatcher, transformMatched, inlineMap } from '@wrap-esm-lambda/core'

/**
 * Build a `registerHooks`-compatible load hook from a config.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export function createLoadHook(config) {
  const match = createMatcher(config)
  return function load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const entry = match(url)
    if (!entry) {
      return result
    }
    const transformed = transformMatched(result.source.toString(), entry, url)
    if (!transformed) {
      // already instrumented (e.g. at build time) — never double-wrap
      return result
    }
    const source = transformed.map ? inlineMap(transformed.code, transformed.map) : transformed.code
    return { format: 'module', shortCircuit: true, source }
  }
}

/**
 * Register the load hook for a config.
 * @param {import('@wrap-esm-lambda/core').InstrumentConfig} config
 */
export function registerConfig(config) {
  registerHooks({ load: createLoadHook(config) })
}
