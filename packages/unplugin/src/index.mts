// Build-time shell of the hybrid setup: the same transforms as the runtime
// hook, run from a bundler's transform stage via unplugin (one codebase →
// Vite/Rolldown, Rollup, esbuild, webpack, Rspack adapters). Runs per-module
// *before* bundling, so package-identity matching still works and the bundler
// composes our returned map with the rest of the chain. Deployed output is
// pre-instrumented: the runtime hook cost drops to zero.
//
// Builtin targets (`node:os`, ...) have no source to transform; the runtime
// shell patches them eagerly at preload. Here the build shell owns module
// RESOLUTION instead: every configured builtin specifier is aliased to a
// generated wrapper module (see core's builtinWrapperSource) that patches
// the real exports object via `process.getBuiltinModule` and re-exports the
// patched bindings — named imports, default imports and even a runtime
// `require()` (which escapes the aliasing but shares the mutated object)
// all observe the patch, and a shared globalThis guard keeps the hybrid
// combination single-patched.
import { isBuiltin } from 'node:module'
import { createUnplugin } from 'unplugin'
import type { InstrumentConfig } from '@wrap-esm-lambda/core'
import {
  matchEntries,
  applyMatched,
  builtinAliases,
  builtinPatchEntries,
  builtinWrapperSource,
} from '@wrap-esm-lambda/core'

// The virtual-id prefix walks a narrow lane: no '/' (unplugin's esbuild
// adapter derives resolveDir via dirname, which must stay '.' so the
// wrapper's own imports resolve), and no scheme shape — the '_' is illegal
// in URI schemes, so webpack never routes the id down its scheme path,
// where neither resolvers nor plugins would see it.
const BUILTIN_PREFIX = 'wrap-esm-lambda-builtin_'

/**
 * The slice of a webpack/rspack compiler this plugin touches. Both bundlers
 * are optional peers of unplugin — typing them structurally keeps their real
 * types (and their versions) out of this package's dependency graph.
 */
interface WebpackLikeCompiler {
  hooks: {
    normalModuleFactory: {
      tap(name: string, fn: (nmf: NormalModuleFactoryLike) => void): void
    }
  }
  options: {
    externalsPresets: { node?: boolean }
    externals?: unknown
  }
}

interface NormalModuleFactoryLike {
  hooks: {
    beforeResolve: {
      tap(name: string, fn: (data: ResolveDataLike) => void): void
    }
  }
}

interface ResolveDataLike {
  request: string
  dependencies?: { request: string }[]
}

/**
 * webpack/rspack route builtin requests to their node-externals preset at
 * `factorize`, before any resolver (and so before unplugin's resolveId)
 * runs. `beforeResolve` fires earlier: rewriting the request there makes it
 * an ordinary module request that flows into unplugin's resolver + virtual
 * module machinery like on every other bundler.
 */
function interceptBuiltinRequests(compiler: WebpackLikeCompiler, aliases: Map<string, string>): void {
  compiler.hooks.normalModuleFactory.tap('wrap-esm-lambda', (nmf) => {
    nmf.hooks.beforeResolve.tap('wrap-esm-lambda', (resolveData) => {
      const name = aliases.get(resolveData.request)
      if (name !== undefined) {
        const virtual = BUILTIN_PREFIX + name
        resolveData.request = virtual
        // webpack's externals check reads the DEPENDENCY's request, not
        // resolveData's — both must change or the node-externals preset
        // still externalizes the original builtin id. rspack's resolveData
        // carries no dependencies array (its externals check reads the
        // rewritten request), so this loop is webpack-only.
        for (const dependency of resolveData.dependencies ?? []) {
          dependency.request = virtual
        }
      }
    })
  })
}

export const unplugin = createUnplugin((config: InstrumentConfig) => {
  const aliases = builtinAliases(config)
  return {
    name: 'wrap-esm-lambda',
    enforce: 'pre',
    webpack(compiler) {
      if (aliases.size > 0) interceptBuiltinRequests(compiler as unknown as WebpackLikeCompiler, aliases)
    },
    rspack(compiler) {
      if (aliases.size > 0) {
        const rspackCompiler = compiler as unknown as WebpackLikeCompiler
        interceptBuiltinRequests(rspackCompiler, aliases)
        // rspack decides externals in Rust, before the beforeResolve rewrite
        // is read back — the node preset externalizes the original builtin id
        // and the virtual module never happens. Carve the configured builtins
        // out of the preset and reproduce its behavior for every other
        // builtin with an externals function (which rspack does consult
        // before its preset would have run).
        rspackCompiler.options.externalsPresets.node = false
        const existing = rspackCompiler.options.externals
        rspackCompiler.options.externals = [
          ...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]),
          ({ request }: { request: string }, callback: (err?: Error | null, result?: string) => void) => {
            if (!aliases.has(request) && isBuiltin(request)) {
              return callback(null, `node-commonjs ${request}`)
            }
            callback()
          },
        ]
      }
    },
    resolveId(id: string) {
      // identity for the virtual id itself: webpack re-resolves the
      // rewritten request through unplugin's resolver plugin, which needs a
      // non-null answer to register it as a virtual module
      if (id.startsWith(BUILTIN_PREFIX)) return id
      const name = aliases.get(id)
      return name === undefined ? null : BUILTIN_PREFIX + name
    },
    loadInclude(id: string) {
      return id.startsWith(BUILTIN_PREFIX)
    },
    load(id: string) {
      const name = id.slice(BUILTIN_PREFIX.length)
      // builtinPatchEntries applies the versionRange gate (the building
      // Node answers for the bundle), same as the runtime shell at preload
      const entries = builtinPatchEntries(config).filter((entry) => entry.module.name === name)
      return builtinWrapperSource(name, entries)
    },
    transformInclude(id: string) {
      return matchEntries(config, id).length > 0
    },
    transform(code: string, id: string) {
      const entries = matchEntries(config, id)
      if (entries.length === 0) {
        return null
      }
      // no explicit format here — core falls back to syntax detection
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
export const rolldownPlugin = unplugin.rolldown
export const esbuildPlugin = unplugin.esbuild
export const webpackPlugin = unplugin.webpack
export const rspackPlugin = unplugin.rspack
export default unplugin
