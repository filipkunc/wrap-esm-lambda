// The CJS evaluation wrap. Appending the tap after a CJS module's source is
// not enough: the CJS wrapper is a function, so a module that executes a
// top-level `return` (conditional early-exit modules exist in the wild)
// would never reach an appended snippet — the patch would silently not run,
// in both delivery modes, since bundlers wrap CJS in a function too. The fix
// is structural — the module body is enclosed so that the tap runs after it
// regardless of how it exits — and it lives here in the apply step because
// the engine cannot do it (the CJS tap never parses, and the wrap must hold
// for string and Buffer sources alike).
//
// The enclosure is an arrow IIFE, `;(() => { <body>\n})(); <tap>`, and the
// arrow is load-bearing — every alternative loses something:
//
// - **`try { <body> } finally { <tap> }`** keeps the tap reachable too, but
//   it puts the body's function declarations in a BLOCK. In sloppy mode
//   (most handwritten CJS) that triggers Annex B semantics, and bundlers
//   lower it by renaming — esbuild turns graceful-fs's top-level
//   `function patch` into `patch2`, an observable `Function.name` change
//   the corpus caught. An arrow body is plain function scope: declarations
//   hoist exactly as they did in the CJS wrapper, nothing is renamed.
// - A **`function` IIFE** would rebind `this` (the CJS `this` is
//   `module.exports`) and `arguments`; the arrow inherits both from the
//   real wrapper unchanged.
//
// What else the arrow preserves, and why:
// - **Strict mode.** A directive prologue at the start of a function body
//   is a real prologue, so the module's own `"use strict"` governs the
//   whole body from inside the arrow — no directive hoisting, no scanner.
//   Only a BOM and a shebang line must stay ahead of the inserted `(`,
//   found by a fixed-shape scan.
// - **Line numbers.** The inserted prefix contains no newline, so every
//   source line keeps its number — existing source maps and stack traces
//   stay valid, only the insertion line's columns shift. (One exception: a
//   shebang line the source did not terminate gets a newline first, or the
//   prefix would vanish into the shebang comment — and such a file has no
//   further lines to shift.)
// - **Throw parity.** The tap sits AFTER the IIFE call, so a body that
//   throws never reaches it — a module that failed to evaluate is not
//   patched, exactly like the appended ESM tap. No guard flag needed, and
//   with it goes the one module-scope binding a guard would have added:
//   the wrap introduces no names at all, so nothing can collide.
// - **Named ESM imports.** cjs-module-lexer detects `exports.X =` patterns
//   inside a function wrapper fine (transpiled CJS has always looked like
//   this), so Node's named-import surface of the wrapped module keeps
//   resolving.
//
// One preservation claim above needs help: "only the insertion line's
// columns shift" is harmless for handwritten code but fatal for a MINIFIED
// single-line bundle — there the insertion line is the whole module, its
// source map is all line-0 columns, and a 10-column shift resolves every
// stack frame to the wrong original position (js-yaml's shipped dist turns
// `readFlowCollection` into `state`). `cjsWrapMap` repairs exactly that:
// when the module carries its own source map (inline data URL or an
// external file next to it) AND the insertion line has mapped segments, it
// returns a corrected copy of that map — the first segment of the insertion
// line moved right by the prefix width, which reflows every later segment
// on the line since VLQ columns are deltas. The runtime hook inlines the
// corrected map after the code (the last `sourceMappingURL` comment wins),
// and the build shell hands it to the bundler, which composes maps itself.
// When nothing mapped moves (a banner comment owns the insertion line, or
// there is no map at all) it returns null and the output stays byte-lean.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cleanPath } from './paths.mjs'

const LF = 0x0a
const BANG = 0x21
const HASH = 0x23

/** The three pieces `applyMatched` splices around a CJS source. */
export interface CjsWrap {
  /** offset where `prefix` is inserted (after a BOM and a shebang line) */
  insertAt: number
  /** opens the IIFE — starts with `;` so an unterminated prior token cannot
   * swallow it */
  prefix: string
  /** closes and calls the IIFE, then delivers the snippets */
  trailer: string
}

/**
 * Build the evaluation wrap for one CJS module: the body becomes an arrow
 * IIFE and `snippets` (the engine's tap emission, unchanged) follow the
 * call, running only when the body completed — through a top-level
 * `return`, but never after a throw.
 */
export function cjsEvalWrap(source: string | Buffer, snippets: string): CjsWrap {
  const len = source.length
  const at: (i: number) => number =
    typeof source === 'string' ? (i) => source.charCodeAt(i) : (i) => source[i] as number
  let i = 0
  if (typeof source === 'string') {
    if (len > 0 && at(0) === 0xfeff) i = 1
  } else if (len >= 3 && at(0) === 0xef && at(1) === 0xbb && at(2) === 0xbf) {
    i = 3
  }
  let prefix = ';(() => { '
  // a shebang is only a shebang as the very first bytes; keep its whole line
  if (i + 1 < len && at(i) === HASH && at(i + 1) === BANG) {
    i += 2
    while (i < len && at(i) !== LF) i++
    if (i < len) {
      i++
    } else {
      // shebang without a trailing newline: gluing the prefix onto that line
      // would bury it in the shebang comment
      prefix = `\n${prefix}`
    }
  }
  return { insertAt: i, prefix, trailer: `\n})();${snippets}` }
}

/**
 * A corrected copy of the module's OWN source map, compensating for the
 * columns `wrap.prefix` occupies on the insertion line — or null when the
 * module has no discoverable map, the map is unusable, or no mapped segment
 * sits on that line (then nothing moved and emitting a map would only bloat
 * the output). The caveat of re-homing an external map inline: sources then
 * resolve relative to the module file instead of the map file — identical
 * whenever the two sit in the same directory, which is where bundlers put
 * them.
 */
export function cjsWrapMap(source: string | Buffer, wrap: CjsWrap, idOrUrl: string): string | null {
  if (wrap.prefix.charCodeAt(0) === LF) {
    // the unterminated-shebang shape: the file is a single shebang line, so
    // there is no mapped code to protect
    return null
  }
  const map = upstreamMap(source, idOrUrl)
  if (map == null || typeof map.mappings !== 'string' || 'sections' in map) {
    return null
  }
  let insertLine = 0
  const at: (i: number) => number =
    typeof source === 'string' ? (i) => source.charCodeAt(i) : (i) => source[i] as number
  for (let i = 0; i < wrap.insertAt; i++) {
    if (at(i) === LF) insertLine++
  }
  const lines = map.mappings.split(';')
  const line = lines[insertLine]
  if (!line) {
    return null
  }
  const shifted = shiftLeadingColumn(line, wrap.prefix.length)
  if (shifted == null) {
    return null
  }
  lines[insertLine] = shifted
  map.mappings = lines.join(';')
  return JSON.stringify(map)
}

/** The map the module itself points at, via its last `sourceMappingURL=`. */
function upstreamMap(source: string | Buffer, idOrUrl: string): { mappings?: unknown } | null {
  const NEEDLE = 'sourceMappingURL='
  const idx = source.lastIndexOf(NEEDLE)
  if (idx < 0 || !isMagicComment(source, idx)) {
    return null
  }
  const at: (i: number) => number =
    typeof source === 'string' ? (i) => source.charCodeAt(i) : (i) => source[i] as number
  let end = idx + NEEDLE.length
  while (end < source.length) {
    const c = at(end)
    if (c === LF || c === 0x0d || c === 0x20 || c === 0x09) break
    end++
  }
  const url =
    typeof source === 'string'
      ? source.slice(idx + NEEDLE.length, end)
      : source.subarray(idx + NEEDLE.length, end).toString('utf8')
  try {
    if (url.startsWith('data:')) {
      // inline map: only the base64 flavor is worth supporting
      const comma = url.indexOf(',')
      if (comma < 0 || !url.slice(0, comma).includes('base64')) {
        return null
      }
      return JSON.parse(Buffer.from(url.slice(comma + 1), 'base64').toString('utf8')) as { mappings?: unknown }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      // any other scheme (http:, webpack:, …) is not a neighbor file
      return null
    }
    const mapPath = resolve(dirname(cleanPath(idOrUrl)), url)
    return JSON.parse(readFileSync(mapPath, 'utf8')) as { mappings?: unknown }
  } catch {
    // an unreadable or malformed map leaves the module exactly as unmapped
    return null
  }
}

/** True when `sourceMappingURL=` at `idx` sits in a `//#`/`//@` comment. */
function isMagicComment(source: string | Buffer, idx: number): boolean {
  const at: (i: number) => number =
    typeof source === 'string' ? (i) => source.charCodeAt(i) : (i) => source[i] as number
  let i = idx - 1
  while (i >= 0 && (at(i) === 0x20 || at(i) === 0x09)) i--
  if (i < 0 || (at(i) !== HASH && at(i) !== 0x40)) return false
  return i >= 2 && at(i - 1) === 0x2f && at(i - 2) === 0x2f
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Move a mappings line's first segment `by` generated columns to the right.
 * Only the leading VLQ field changes — within a line every later segment's
 * column is a delta off the previous one, so the whole line reflows.
 */
function shiftLeadingColumn(line: string, by: number): string | null {
  let value = 0
  let shift = 0
  let i = 0
  for (;;) {
    if (i >= line.length) return null
    const digit = B64.indexOf(line[i]!)
    if (digit < 0) return null
    i++
    value += (digit & 31) << shift
    if ((digit & 32) === 0) break
    shift += 5
  }
  const column = (value & 1 ? -(value >>> 1) : value >>> 1) + by
  let vlq = column < 0 ? (-column << 1) | 1 : column << 1
  let encoded = ''
  do {
    let digit = vlq & 31
    vlq >>>= 5
    if (vlq > 0) digit |= 32
    encoded += B64[digit]
  } while (vlq > 0)
  return encoded + line.slice(i)
}
