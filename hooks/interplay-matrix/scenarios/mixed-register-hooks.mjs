// The #57327 shape: an off-thread module.register() loader (what OTel-style
// tooling installs) combined with sync registerHooks. On broken versions the
// sync chain receives the async default's nullish CJS source and dies with
// ERR_INVALID_RETURN_PROPERTY_VALUE.
import { createRequire, register, registerHooks } from 'node:module'

if (typeof registerHooks !== 'function') {
  console.log('RESULT:NO_REGISTERHOOKS')
  process.exit(0)
}

register(new URL('../fixtures/async-loader.mjs', import.meta.url))
registerHooks({
  load(url, context, nextLoad) {
    return nextLoad(url, context)
  },
})

const require = createRequire(import.meta.url)
require('../fixtures/dep.cjs')
await import('../fixtures/dep-esm.mjs')

console.log('RESULT:OK')
