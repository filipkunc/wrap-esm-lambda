// The eager alternative for built-ins: a declarative config knows its
// targets up front, so a preload can require('node:os') and mutate the
// exports object BEFORE any user code loads — no Module._load interception,
// no loader hooks. This checks every consumer shape then observes the patch:
// require(), ESM default import, and ESM named import (the named binding is
// captured when the facade is created, which is after preload — so it must
// see the patched function too).
import { createRequire, registerHooks } from 'node:module'

const require = createRequire(import.meta.url)

// simulate the preload: patch before anything else touches node:os
const os = require('node:os')
const origHostname = os.hostname
os.hostname = function () {
  return `patched:${origHostname.call(this)}`
}

// sync hooks registered after, as the runtime shell does — must not disturb it
if (typeof registerHooks === 'function') {
  registerHooks({
    load(url, context, nextLoad) {
      return nextLoad(url, context)
    },
  })
}

const viaRequire = require('node:os').hostname()
const namespace = await import('node:os')
const viaDefault = namespace.default.hostname()
const viaNamed = namespace.hostname()

const all = [viaRequire, viaDefault, viaNamed]
const patched = all.filter((v) => v.startsWith('patched:')).length
console.log(patched === 3 ? 'RESULT:PATCHED_ALL' : `RESULT:PATCHED_${patched}_OF_3`)
