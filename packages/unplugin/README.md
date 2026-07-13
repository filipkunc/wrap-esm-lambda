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
