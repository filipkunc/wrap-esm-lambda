// The nearest-package.json directory walk, shared by the two lookups that
// differ only in what they read from the file: match.mjs wants the nearest
// NAMED package (skipping the nameless `{"type":"commonjs"}` markers dual
// packages plant), format.mjs wants Node's own rule — the first
// package.json at all. `read` returns undefined to keep walking; `miss` is
// the filesystem-root answer. Every visited directory is backfilled into
// `cache` (the miss included), so the many files of one package cost one
// walk — the property that keeps the runtime hook cold-start-cheap.
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

export function nearestPackageValue<T>(
  filePath: string,
  cache: Map<string, T>,
  read: (pkg: Record<string, unknown>, dir: string) => T | undefined,
  miss: T,
): T {
  let dir = dirname(filePath)
  const visited: string[] = []
  while (true) {
    if (cache.has(dir)) {
      const hit = cache.get(dir) as T
      for (const d of visited) cache.set(d, hit)
      return hit
    }
    visited.push(dir)
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
      const value = read(pkg, dir)
      if (value !== undefined) {
        for (const d of visited) cache.set(d, value)
        return value
      }
    } catch {
      // no package.json here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) {
      for (const d of visited) cache.set(d, miss)
      return miss
    }
    dir = parent
  }
}
