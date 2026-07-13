// Build-time shell of the hybrid setup: the same transform as the runtime
// hook, run from a bundler's transform stage via unplugin (one codebase →
// Vite/Rolldown, Rollup, esbuild, webpack, Rspack adapters). Runs per-module
// *before* bundling, so matching by file path still works and the bundler
// composes our returned map with the rest of the chain. Deployed output is
// pre-instrumented: the runtime hook cost drops to zero.
import { createUnplugin } from 'unplugin'
import { createMatcher, transformMatched } from '@wrap-esm-lambda/core'

/** @param {import('@wrap-esm-lambda/core').InstrumentConfig} config */
export const unplugin = createUnplugin((config) => {
  const match = createMatcher(config)
  return {
    name: 'wrap-esm-lambda',
    enforce: 'pre',
    transformInclude(id) {
      return Boolean(match(id))
    },
    transform(code, id) {
      const entry = match(id)
      if (!entry) {
        return null
      }
      const transformed = transformMatched(code, entry, id)
      if (!transformed) {
        return null // already instrumented — never double-wrap
      }
      return { code: transformed.code, map: transformed.map }
    },
  }
})

export const vitePlugin = unplugin.vite
export const rollupPlugin = unplugin.rollup
export const esbuildPlugin = unplugin.esbuild
export const webpackPlugin = unplugin.webpack
export const rspackPlugin = unplugin.rspack
export default unplugin
