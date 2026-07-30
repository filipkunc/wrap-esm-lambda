// Build-time delivery of the same instrumentation: esbuild bundles each
// handler with the unplugin adapter, and every patch lands inside the
// bundle — the handler rewrite, the Hono subclass, the smithy send tap. At
// runtime the bundle is just JavaScript: no hook, no config, no engine, no
// preload. dist/ then boots on the Lambda image with nothing but
// LAMBDA_TASK_ROOT pointed at it.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.build.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

for (const entry of ['app.mjs', 'consumer.mjs']) {
  await build({
    entryPoints: [here(entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    sourcemap: true,
    outfile: here(`dist/${entry}`),
    plugins: [esbuildPlugin(config)],
    logLevel: 'silent',
  })
}
console.log('built dist/app.mjs and dist/consumer.mjs with the patches baked in')
