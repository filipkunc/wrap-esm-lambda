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
// The scan compares ASCII bytes only, so it works on UTF-8 Buffers and
// strings identically — the byte fast path never decodes.

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
