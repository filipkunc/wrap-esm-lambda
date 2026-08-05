// CJS-or-ESM decisions. The tap's emitted snippet differs per module system,
// so getting this wrong mis-parses a module — these helpers reproduce the
// format Node itself would assign.
import { cleanPath } from './paths.mjs'
import { hasModuleSyntax } from './engine.mjs'
import { nearestPackageValue } from './package-walk.mjs'

// Nearest "type" field, Node's rule: the FIRST package.json up the tree
// decides, named or not — dual packages mark their CJS tree with a nameless
// `{"type":"commonjs"}` (hono does exactly this), which the named-package
// walk in match.mjs would skip.
const typeCache = new Map<string, ModuleType>()

type ModuleType = 'commonjs' | 'module'

function nearestPackageType(filePath: string): ModuleType {
  return nearestPackageValue(filePath, typeCache, (pkg) => (pkg.type === 'module' ? 'module' : 'commonjs'), 'commonjs')
}

/**
 * The format Node itself would assign a file at runtime: extension first
 * (`.cjs`/`.mjs`), else the nearest package.json `"type"`. The runtime hook
 * uses this when `nextLoad` returns no format (require()d `.js` files), so a
 * pure-CJS package like express is never mis-parsed as ESM and a dual
 * package like hono resolves each dist tree to its real format.
 */
export function runtimeFormatFor(idOrUrl: string): ModuleType {
  const path = cleanPath(idOrUrl)
  if (path.endsWith('.cjs')) return 'commonjs'
  if (path.endsWith('.mjs')) return 'module'
  return nearestPackageType(path)
}

/**
 * 'cjs' or 'esm' for a module. An explicit loader-hook format wins; then the
 * unambiguous extensions; then — when the caller can supply the source — the
 * same syntax detection bundlers and Node's ambiguous-`.js` rule apply: a
 * module with ESM syntax (`import`/`export` statements, `import.meta`) is
 * ESM, anything else is CJS. That is the decision that holds at build time,
 * where a package.json `"type"` walk would misread the many dual/ESM
 * packages whose `"module"`-field trees carry no `"type"` (the AWS SDK's
 * `dist-es`) and a path heuristic misread pure-CJS `.js` files (express).
 *
 * @param format explicit 'commonjs' | 'module' when known
 * @param sourceText lazy source accessor for the syntax fallback; without it
 *   the historic bundler default (ESM) stands
 */
export function moduleKindFor(idOrUrl: string, format?: string, sourceText?: () => string): 'cjs' | 'esm' {
  if (format === 'commonjs') return 'cjs'
  if (format === 'module') return 'esm'
  const path = cleanPath(idOrUrl)
  if (path.endsWith('.cjs')) return 'cjs'
  if (path.endsWith('.mjs')) return 'esm'
  if (path.includes('/dist-cjs/')) return 'cjs'
  if (sourceText !== undefined) {
    return hasModuleSyntax(sourceText()) ? 'esm' : 'cjs'
  }
  return 'esm'
}
