// The apply step: turn matched entries into instrumented source, via the
// selected transform engine (native oxc by default, pure-JS acorn via
// WRAP_ESM_LAMBDA_ENGINE — see engine.mjs). Both shells call `applyMatched`,
// so for a given delivery the instrumented output is byte-identical
// whichever mode produced it.
import { basename } from 'node:path'
import { exportsTap, exportsTapFromBuffer } from './engine.mjs'
import { cleanPath } from './paths.mjs'
import { moduleKindFor } from './format.mjs'
import { tapWithStarRetry } from './stars.mjs'
import type { TapEntryInput } from './engine.mjs'
import type { InstrumentEntry, PatchEntry } from './config.mjs'

/** What both shells hand to the transform: text, or the loader's raw bytes. */
export type Source = string | Buffer | ArrayBuffer | NodeJS.TypedArray

/** How the emitted tap reaches the user's patch function. */
export type Delivery = 'import' | 'registry'

export interface ApplyOptions {
  /** 'commonjs' | 'module' when the caller knows (the runtime hook always does) */
  format?: string
  delivery?: Delivery
}

/** Instrumented output: `code` stays a Buffer on the byte-in fast path. */
export interface Applied {
  code: string | Buffer
  map: string | null
}

/**
 * Marker appended to every transformed module. Both shells skip sources that
 * already carry it, so running the runtime hook on top of a build-time
 * instrumented bundle never double-wraps. It is a legal comment (`/*!`) so
 * bundlers and minifiers keep it in the output by default — a regular comment
 * would be stripped and the guard lost. Detection keys on the inner text
 * only: esbuild's legal-comment hoisting rewrites the comment delimiters
 * (`/*! ... *\/` becomes `(*! ... *)` inside its license block), so matching
 * the full comment would silently defeat the guard on bundled output.
 */
export const SENTINEL_TEXT = '@wrap-esm-lambda instrumented'
export const SENTINEL = `/*! ${SENTINEL_TEXT} */`

/** The tap inputs for the native call, one element per patch entry. */
function tapEntries(patches: PatchEntry[]): TapEntryInput[] {
  return patches.map((entry, aliasIndex) => ({
    bindings: entry.bindings,
    patchName: entry.patch.name,
    patchFrom: entry.patch.from,
    aliasIndex,
  }))
}

/**
 * Apply every matching entry to a module, in one pass shared by both shells:
 * all entries go to the exports tap in a single call — one parse for all of
 * them. The sentinel lands once at the end.
 *
 * The tap itself is tiered: bindings that are already reassignable locals
 * cost only an appended snippet, while shapes that need restructuring
 * (`export const`, an anonymous `export default`, re-exports, import-backed
 * list exports) come back as a regenerated module plus a source map.
 *
 * `delivery` decides how the tap reaches the user's patch function:
 * - 'import' (build time, default): a static import is appended and the
 *   bundler resolves and bundles the patch code.
 * - 'registry' (runtime): no import is injected — the tap looks the patch up
 *   in the `PATCH_REGISTRY` global, which `registerConfig` populates before
 *   any module loads. Hook-overridden CJS sources cannot serve an injected
 *   require, so this is the only delivery that works universally at runtime.
 *
 * A `Buffer` (or any TypedArray/ArrayBuffer, e.g. straight from a
 * `registerHooks` load hook's `nextLoad`) is also accepted as `source`. For
 * matches that stay on the tap's fast path the source then never
 * leaves UTF-8 — it crosses napi zero-copy for validation and one
 * `Buffer.concat` appends the snippets — and `code` in the result is a
 * `Buffer` a load hook can return as-is. When the tap has to rewrite, the
 * regenerated module comes back as a string (that O(n) is the price of the
 * shapes that need it, paid only by modules that need it).
 *
 * @returns null when nothing applies or the source is already instrumented
 */
// Text in, text out: the build shell hands bundlers a string and they accept
// nothing else, so the Buffer half of the return type must not reach them.
export function applyMatched(
  source: string,
  entries: InstrumentEntry[],
  idOrUrl: string,
  options?: ApplyOptions,
): { code: string; map: string | null } | null
export function applyMatched(
  source: Source,
  entries: InstrumentEntry[],
  idOrUrl: string,
  options?: ApplyOptions,
): Applied | null
export function applyMatched(
  source: Source,
  entries: InstrumentEntry[],
  idOrUrl: string,
  options: ApplyOptions = {},
): Applied | null {
  let input: string | Buffer
  if (typeof source === 'string' || Buffer.isBuffer(source)) {
    input = source
  } else if (ArrayBuffer.isView(source)) {
    // zero-copy views, not copies: Buffer.from(ArrayBuffer) aliases the memory
    input = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  } else {
    input = Buffer.from(source)
  }
  // works on both: Buffer#includes(string) is a UTF-8 byte search
  if (entries.length === 0 || input.includes(SENTINEL_TEXT)) {
    return null
  }
  // With no explicit format (the build shell — bundlers decide a module's
  // format after transforms run), fall back to the same syntax detection
  // they use. The thunk never fires on the runtime path: the hook always
  // passes a format, so the buffer fast path stays zero-copy.
  const src = input
  const kind = moduleKindFor(idOrUrl, options.format, () => (typeof src === 'string' ? src : src.toString('utf8')))
  const cjs = kind === 'cjs'
  const registry = options.delivery === 'registry'
  const filename = basename(cleanPath(idOrUrl))

  if (Buffer.isBuffer(input)) {
    // buffer fast path: the source crosses napi zero-copy; only when the tap
    // must rewrite does it come back as a (string) module
    const buf = input
    const tap = tapWithStarRetry(
      (entriesInput, ...rest) => exportsTapFromBuffer(cjs ? EMPTY_BUFFER : buf, entriesInput, ...rest),
      () => buf.toString('utf8'),
      cleanPath(idOrUrl),
      tapEntries(entries),
      cjs,
      registry,
      filename,
      undefined,
    )
    const trailer = `${tap.snippets}\n${SENTINEL}\n`
    if (tap.code == null) {
      return { code: Buffer.concat([buf, Buffer.from(trailer)]), map: null }
    }
    return { code: tap.code + trailer, map: tap.map ?? null }
  }

  const text: string = input
  const tap = tapWithStarRetry(
    (entriesInput, ...rest) => exportsTap(cjs ? '' : text, entriesInput, ...rest),
    () => text,
    cleanPath(idOrUrl),
    tapEntries(entries),
    cjs,
    registry,
    filename,
    undefined,
  )
  let code = tap.code != null ? tap.code : text
  const map = tap.code != null ? (tap.map ?? null) : null
  code += tap.snippets
  code += `\n${SENTINEL}\n`
  return { code, map }
}

const EMPTY_BUFFER = Buffer.alloc(0)

/** Inline a v3 map JSON as a trailing `//# sourceMappingURL=` data URL. */
export function inlineMap(code: string | Buffer, mapJson: string): string {
  const base64 = Buffer.from(mapJson, 'utf8').toString('base64')
  return `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`
}
