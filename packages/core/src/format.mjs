// CJS-or-ESM decisions. The tap's emitted snippet differs per module system,
// so getting this wrong mis-parses a module — these helpers reproduce the
// format Node itself would assign.
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { cleanPath } from './paths.mjs'

// Nearest "type" field, Node's rule: the FIRST package.json up the tree
// decides, named or not — dual packages mark their CJS tree with a nameless
// `{"type":"commonjs"}` (hono does exactly this), which the named-package
// walk in match.mjs would skip.
const typeCache = new Map()

function nearestPackageType(filePath) {
  let dir = dirname(filePath)
  const visited = []
  while (true) {
    if (typeCache.has(dir)) {
      const hit = typeCache.get(dir)
      for (const d of visited) typeCache.set(d, hit)
      return hit
    }
    visited.push(dir)
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const type = pkg.type === 'module' ? 'module' : 'commonjs'
      for (const d of visited) typeCache.set(d, type)
      return type
    } catch {
      // no package.json here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) {
      for (const d of visited) typeCache.set(d, 'commonjs')
      return 'commonjs'
    }
    dir = parent
  }
}

/**
 * The format Node itself would assign a file at runtime: extension first
 * (`.cjs`/`.mjs`), else the nearest package.json `"type"`. The runtime hook
 * uses this when `nextLoad` returns no format (require()d `.js` files), so a
 * pure-CJS package like express is never mis-parsed as ESM and a dual
 * package like hono resolves each dist tree to its real format.
 * @returns {'commonjs' | 'module'}
 */
export function runtimeFormatFor(idOrUrl) {
  const path = cleanPath(idOrUrl)
  if (path.endsWith('.cjs')) return 'commonjs'
  if (path.endsWith('.mjs')) return 'module'
  return nearestPackageType(path)
}

/**
 * 'cjs' or 'esm' for a module: an explicit loader-hook format wins, otherwise
 * a path heuristic (`.cjs`, `dist-cjs`) decides. Bundlers see the `module`
 * entry points, so their default is ESM.
 */
export function moduleKindFor(idOrUrl, format) {
  if (format === 'commonjs') return 'cjs'
  if (format === 'module') return 'esm'
  const path = cleanPath(idOrUrl)
  if (path.endsWith('.cjs') || path.includes('/dist-cjs/')) return 'cjs'
  return 'esm'
}
