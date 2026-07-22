// The #62786 regression shape: CJS `import`-ed through the ESM loader with a
// hook-provided source gets a synthetic require() — does that require still
// carry .extensions and .cache, which pirates/ts-node/Next read at module
// top level?
import { registerHooks } from 'node:module'

if (typeof registerHooks !== 'function') {
  console.log('RESULT:NO_REGISTERHOOKS')
  process.exit(0)
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.includes('/fixtures/dep-ext.cjs')) {
      const out = { shortCircuit: true, source: Buffer.concat([Buffer.from(result.source), Buffer.from('\n;\n')]) }
      if (result.format != null) out.format = result.format
      return out
    }
    return result
  },
})

const { default: dep } = await import('../fixtures/dep-ext.cjs')

if (dep.hasExtensions && dep.hasCache) console.log('RESULT:FULL_REQUIRE')
else if (!dep.hasExtensions && dep.hasCache) console.log('RESULT:NO_EXTENSIONS')
else if (dep.hasExtensions && !dep.hasCache) console.log('RESULT:NO_CACHE')
else console.log('RESULT:BARE_REQUIRE')
