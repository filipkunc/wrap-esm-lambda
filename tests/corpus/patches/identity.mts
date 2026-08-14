// The identity patch: does nothing to the module — its whole job is to have
// been called. Every corpus package is tapped with this over its full
// statically visible export surface; the consumers then assert (a) the patch
// ran and (b) the module's observable exports are unchanged. Counting lives
// on a global so the consumer process can read it whichever delivery
// (registry preload or bundled import) invoked the patch. Self-contained on
// purpose: build delivery bundles this file into every build-cell bundle.
const KEY = Symbol.for('wrap-esm-lambda-corpus.runs')

export function identityPatch(): void {
  const g = globalThis as Record<symbol, unknown>
  g[KEY] = ((g[KEY] as number | undefined) ?? 0) + 1
}
