# `@wrap-esm-lambda/unplugin`

The build-time half of the hybrid setup: the same native oxc transform as the
runtime hook, run from your bundler's transform stage via
[unplugin](https://unplugin.unjs.io/) — one codebase, adapters for
Vite/Rolldown, Rollup, esbuild, webpack and Rspack. Modules are wrapped
_before_ bundling (file-path matching still works) and the bundler composes
the returned source map with the rest of the chain. The deployed artifact is
pre-instrumented, so cold start pays nothing.

```js
// esbuild
import { build } from 'esbuild'
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.mjs'

await build({
  entryPoints: ['app.mjs'],
  bundle: true,
  format: 'esm',
  sourcemap: true,
  plugins: [esbuildPlugin(config)],
})
```

```js
// vite.config.js
import { vitePlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.mjs'

export default { plugins: [vitePlugin(config)] }
```

The config file is shared verbatim with `@wrap-esm-lambda/hooks`, and the
sentinel guard means enabling both modes at once never double-wraps.

## Which engine transforms your build

The plugin runs [core's engine indirection](../core/README.md#choosing-the-engine),
so the opening line's "native oxc transform" is the **default**, not the
only option: `WRAP_ESM_LAMBDA_ENGINE=oxc|acorn` selects explicitly, and
when the variable is unset a native addon that fails to load degrades to
the pure-JS acorn engine instead of failing the build. Name the engine in
CI for exactly that reason — `WRAP_ESM_LAMBDA_ENGINE=oxc` makes a broken
addon a build failure rather than a silent downgrade.

Unlike the runtime shell, here the engine exists **only while the bundler
runs**: both engines emit byte-identical snippets (enforced by the parity
suite), nothing of either ships in the bundle, and the deployed artifact's
cold start is engine-independent — the choice moves build latency only.
The [hono-lambda example's cold-start table](../../examples/hono-lambda/coldStartTable.md)
records which engine built its measured bundles for exactly this reason:
the number doesn't depend on it, but provenance shouldn't have to be
inferred.
