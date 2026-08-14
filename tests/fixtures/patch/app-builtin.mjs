// Exercises every consumer shape of a patched builtin: ESM named import,
// ESM default import, and require(). All three must observe the preload
// patch — the named binding is captured when node:os's ESM facade is
// created, which happens here, after the preload already patched it.
import os, { hostname } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const results = [hostname(), os.hostname(), require('node:os').hostname()]
const patched = results.filter((r) => r.startsWith('patched:')).length
console.log(patched === 3 ? 'builtin:patched-all' : `builtin:patched-${patched}-of-3`)
