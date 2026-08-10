// The whole build-time integration: esbuild plus one plugin, fed the same
// config file the runtime mode reads. The emitted dist/app.mjs is already
// patched — running it needs no flags and none of these devDependencies.
import { build } from 'esbuild'
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.mjs'

await build({
  entryPoints: ['app.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'dist/app.mjs',
  plugins: [esbuildPlugin(config)],
})
