// ESM twin of fingerprint.cts — the implementation is CJS so the require()
// consumer cell never has to require(esm) a helper (see fingerprint.cts for
// the full story). The types live HERE and the .cts imports them type-only
// (erased at runtime, so no cycle): TypeScript cannot model a plain
// `module.exports = {...}` under erasable-syntax-only rules, so this twin
// is also where the implementation gets its public typing.
import { createRequire } from 'node:module'

export interface Fingerprint {
  self: string
  keys: Record<string, string>
}

export interface FingerprintComparison {
  equal: boolean
  detail?: string
  widened: string[]
}

interface FingerprintModule {
  fingerprint: (root: unknown) => Fingerprint
  compareFingerprints: (control: Fingerprint, instrumented: Fingerprint) => FingerprintComparison
}

const impl = createRequire(import.meta.url)('./fingerprint.cts') as FingerprintModule

export const fingerprint = impl.fingerprint
export const compareFingerprints = impl.compareFingerprints
