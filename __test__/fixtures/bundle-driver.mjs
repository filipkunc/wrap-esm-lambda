// Bundles one entry through one unplugin adapter — the shared driver behind
// the multi-bundler test matrix (esbuild, rollup, rolldown, webpack). Runs
// as a child process so WRAP_ESM_LAMBDA_ENGINE picked from the environment
// binds core to the engine under test before the plugin loads.
//
//   node bundle-driver.mjs <bundler> <entry> <configPath> <outfile>
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [bundler, entryArg, configArg, outfileArg] = process.argv.slice(2)
// absolute paths everywhere: webpack treats a bare relative entry as a
// module request, and the config import needs a file URL anyway
const [entry, configPath, outfile] = [entryArg, configArg, outfileArg].map((p) => resolve(p))
const { unplugin } = await import('@wrap-esm-lambda/unplugin')
const { default: config } = await import(pathToFileURL(configPath).href)

switch (bundler) {
  case 'esbuild': {
    const { build } = await import('esbuild')
    await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      plugins: [unplugin.esbuild(config)],
      logLevel: 'silent',
    })
    break
  }
  case 'rollup':
  case 'rolldown': {
    // same plugin-driven API on both; rollup additionally needs node-resolve
    // for bare specifiers, rolldown resolves them natively
    const plugins = [unplugin[bundler](config)]
    let bundle
    if (bundler === 'rollup') {
      const { rollup } = await import('rollup')
      const { nodeResolve } = await import('@rollup/plugin-node-resolve')
      plugins.push(nodeResolve())
      bundle = await rollup({ input: entry, plugins, onwarn: () => {} })
    } else {
      const { rolldown } = await import('rolldown')
      bundle = await rolldown({ input: entry, plugins, onwarn: () => {} })
    }
    await bundle.write({ file: outfile, format: 'esm' })
    await bundle.close()
    break
  }
  case 'webpack': {
    // production mode on purpose: terser minification is where comment
    // preservation earns its keep (pure-annotation shaking, license
    // extraction), and where fragile transforms break
    const { default: webpack } = await import('webpack')
    const compiler = webpack({
      entry,
      mode: 'production',
      target: 'node',
      devtool: false,
      output: {
        path: dirname(outfile),
        filename: basename(outfile),
        module: true,
        library: { type: 'module' },
        chunkFormat: 'module',
      },
      experiments: { outputModule: true },
      plugins: [unplugin.webpack(config)],
    })
    await new Promise((resolve, reject) => {
      compiler.run((err, stats) => {
        if (err) return reject(err)
        if (stats.hasErrors()) return reject(new Error(stats.toString({ errorDetails: true })))
        compiler.close((closeErr) => (closeErr ? reject(closeErr) : resolve()))
      })
    })
    break
  }
  default:
    throw new Error(`bundle-driver: unknown bundler '${bundler}'`)
}
