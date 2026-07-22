// The wrap-esm-lambda shape without the addon: a sync load hook that appends
// a marker statement to a required CJS module's source (Buffer in, Buffer
// out) and to an imported ESM module. #59384-class failures surface here as
// ERR_INVALID_RETURN_PROPERTY_VALUE out of the hook chain.
import { createRequire, registerHooks } from 'node:module'

if (typeof registerHooks !== 'function') {
  console.log('RESULT:NO_REGISTERHOOKS')
  process.exit(0)
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.includes('/fixtures/dep')) {
      const marker = Buffer.from('\n;globalThis.__interplay_appended = (globalThis.__interplay_appended ?? 0) + 1;\n')
      const out = { shortCircuit: true, source: Buffer.concat([Buffer.from(result.source), marker]) }
      if (result.format != null) out.format = result.format
      return out
    }
    return result
  },
})

const require = createRequire(import.meta.url)
require('../fixtures/dep.cjs')
await import('../fixtures/dep-esm.mjs')

console.log(
  globalThis.__interplay_appended === 2 ? 'RESULT:APPENDED' : `RESULT:PARTIAL_${globalThis.__interplay_appended ?? 0}`,
)
