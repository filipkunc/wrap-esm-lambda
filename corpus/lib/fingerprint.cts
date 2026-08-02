// A structural fingerprint of a module's export surface, stable across
// processes: types and names, never identities (which cannot cross a
// process boundary) and never live values (which may differ per run). The
// corpus compares the fingerprint of a control load against the same load
// under instrumentation.
//
// CJS (.cts) on purpose: the require() consumer cell runs as a CJS entry
// under the runtime hook, where require(esm) of a helper would re-enter the
// exact loader corridor the corpus is probing (and on pre-fix 22.x minors,
// break). The ESM twin (fingerprint.mts) re-exports from here.
//
// Property reads go through try/catch: a lazy getter that throws (pg's
// `native` requires pg-native on read) must fingerprint deterministically,
// not kill the probe — and must throw identically with and without the tap.
'use strict'
import type { Fingerprint, FingerprintComparison } from './fingerprint.mts'

function describe(v: unknown): string {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'function') {
    // class vs function matters (a rebind-to-subclass would flip it); name
    // and arity catch accidental wrapper leakage
    const fn = v as { name: string; length: number }
    const cls = /^class[\s{]/.test(Function.prototype.toString.call(v)) ? 'class' : 'function'
    return `${cls} ${fn.name}/${fn.length}`
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v) as { constructor?: { name?: string } } | null
    return `object ${proto === null ? '(null proto)' : (proto.constructor?.name ?? '(anonymous)')}`
  }
  if (t === 'string') {
    const s = v as string
    return `string ${s.length > 48 ? `${s.slice(0, 48)}…` : s}`
  }
  if (t === 'symbol') return `symbol ${(v as symbol).description ?? ''}`
  return `${t} ${String(v)}`
}

function fingerprint(root: unknown): Fingerprint {
  const out: Fingerprint = { self: describe(root), keys: {} }
  if (root !== null && (typeof root === 'object' || typeof root === 'function')) {
    for (const key of Object.keys(root).sort()) {
      let value: unknown
      try {
        value = (root as Record<string, unknown>)[key]
      } catch (err) {
        const e = err as { code?: string; name?: string } | null
        out.keys[key] = `throws ${e?.code ?? e?.name ?? 'Error'}`
        continue
      }
      out.keys[key] = describe(value)
    }
  }
  return out
}

/**
 * Control-vs-instrumented comparison. Everything the control observed must
 * be observed identically under instrumentation; names the instrumented
 * load ADDS are reported separately, not as divergence — appending
 * `module.exports.X` accessor writes makes cjs-module-lexer discover named
 * exports it previously missed, so an import-of-CJS namespace can widen.
 * The names are real properties with correct values; a consumer gains
 * imports, loses nothing. The matrix still records the widening per package.
 */
function compareFingerprints(control: Fingerprint, instrumented: Fingerprint): FingerprintComparison {
  if (control.self !== instrumented.self) {
    return { equal: false, detail: `self: ${control.self} != ${instrumented.self}`, widened: [] }
  }
  for (const key of Object.keys(control.keys)) {
    if (control.keys[key] !== instrumented.keys[key]) {
      return {
        equal: false,
        detail: `${key}: ${control.keys[key]} != ${instrumented.keys[key] ?? '(absent)'}`,
        widened: [],
      }
    }
  }
  const widened = Object.keys(instrumented.keys).filter((key) => !(key in control.keys))
  return { equal: true, widened }
}

module.exports = { fingerprint, compareFingerprints }
