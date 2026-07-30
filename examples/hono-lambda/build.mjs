// Build-time delivery of the same instrumentation: esbuild bundles each
// handler with the unplugin adapter, and every patch lands inside the
// bundle — the handler rewrite, the Hono subclass, the smithy send tap. At
// runtime the bundle is just JavaScript: no hook, no config, no engine, no
// preload. dist/ then boots on the Lambda image with nothing but
// LAMBDA_TASK_ROOT pointed at it.
//
// The transform engine applies at BUILD time only, selected the usual way:
// WRAP_ESM_LAMBDA_ENGINE, defaulting to the native oxc addon with acorn as
// the unavailable-addon fallback (CI pins oxc explicitly so a broken addon
// fails the build instead of degrading). Both engines emit byte-identical
// snippets, so the produced bundle — and its cold start — is the same
// either way; the choice only moves build latency.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { esbuildPlugin } from '@wrap-esm-lambda/unplugin'
import config from './wrap.config.build.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

// --plain builds the measurement control: the identical bundle without the
// plugin, so the bundled deployment's delivery cost is patched-vs-plain on
// the same artifact — not bundled-vs-unbundled, which prices the bundling
// itself.
const plain = process.argv.includes('--plain')
const outDir = plain ? 'dist-plain' : 'dist'

for (const entry of ['app.mjs', 'consumer.mjs']) {
  await build({
    entryPoints: [here(entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    sourcemap: true,
    outfile: here(`${outDir}/${entry}`),
    plugins: plain ? [] : [esbuildPlugin(config)],
    logLevel: 'silent',
  })
}
console.log(
  `built ${outDir}/app.mjs and ${outDir}/consumer.mjs${plain ? ' without patches' : ' with the patches baked in'}`,
)
