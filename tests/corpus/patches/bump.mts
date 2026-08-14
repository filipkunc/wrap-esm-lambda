// Shared counter for the behavioral probes: every wrapped call bumps it,
// the driver (via ../lib/probe-count.mts) asserts it moved. A relative
// import inside a patch module graph is explicitly supported in both
// delivery modes — see the patch author contract in packages/core/README.md.
const KEY = Symbol.for('wrap-esm-lambda-corpus.probe')

export function bump(): void {
  const g = globalThis as Record<symbol, unknown>
  g[KEY] = ((g[KEY] as number | undefined) ?? 0) + 1
}
