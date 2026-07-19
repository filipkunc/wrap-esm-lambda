// Build-time shell of the hybrid setup: the same transforms as the runtime
// hook, run from a bundler's transform stage via unplugin (one codebase →
// Vite/Rolldown, Rollup, esbuild, webpack, Rspack adapters). Runs per-module
// *before* bundling, so package-identity matching still works and the bundler
// composes our returned map with the rest of the chain. Deployed output is
// pre-instrumented: the runtime hook cost drops to zero.
import { createUnplugin } from 'unplugin'
import { matchEntries, applyMatched } from '@wrap-esm-lambda/core'

/** @param {import('@wrap-esm-lambda/core').InstrumentConfig} config */
export const unplugin = createUnplugin((config) => {
  return {
    name: 'wrap-esm-lambda',
    enforce: 'pre',
    transformInclude(id) {
      return matchEntries(config, id).length > 0
    },
    transform(code, id) {
      const entries = matchEntries(config, id)
      if (entries.length === 0) {
        return null
      }
      // no format hint here — the path heuristic in core decides cjs/esm
      const applied = applyMatched(code, entries, id)
      if (!applied) {
        return null // already instrumented — never double-wrap
      }
      return { code: applied.code, map: applied.map }
    },
  }
})

export const vitePlugin = unplugin.vite
export const rollupPlugin = unplugin.rollup
export const esbuildPlugin = unplugin.esbuild
export const webpackPlugin = unplugin.webpack
export const rspackPlugin = unplugin.rspack
export default unplugin
