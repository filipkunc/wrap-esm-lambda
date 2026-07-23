// The apply step: turn matched entries into instrumented source, via the
// native `wrap-esm-lambda` oxc addon. Both shells call `applyMatched`, so
// the instrumented output is byte-identical whichever mode produced it.
import { basename } from 'node:path'
import { transformLambdaWithMapObject, exportsTapSnippet, exportsTapSnippetFromBuffer } from 'wrap-esm-lambda'
import { cleanPath } from './paths.mjs'
import { moduleKindFor } from './format.mjs'

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

/**
 * The original wrap transform: rebind an exported const through the wrapper
 * via the native oxc transform, append the wrapper import (ESM imports are
 * hoisted, so appending keeps every existing line — and therefore the source
 * map — intact) and the double-wrap sentinel.
 *
 * @returns {{ code: string, map: string | null } | null} null when the source
 *   is already instrumented
 */
export function transformMatched(source, entry, idOrUrl) {
  if (source.includes(SENTINEL_TEXT)) {
    return null
  }
  const filename = basename(cleanPath(idOrUrl))
  const { code, map } = transformLambdaWithMapObject(source, entry.handler, entry.wrapper.name, filename)
  let finalCode = code
  if (entry.wrapper.from) {
    finalCode += `\nimport { ${entry.wrapper.name} } from ${JSON.stringify(entry.wrapper.from)};`
  }
  finalCode += `\n${SENTINEL}\n`
  return { code: finalCode, map: map ?? null }
}

/**
 * Apply every matching entry to a module, in one pass shared by both shells.
 * Wrap entries run first (they re-generate the whole module); patch entries
 * append their exports tap after, so nothing they add is disturbed. The
 * sentinel lands once at the end.
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
 * `registerHooks` load hook's `nextLoad`) is also accepted as `source`. When
 * every matching entry is a patch entry the source then never leaves UTF-8 —
 * it crosses napi zero-copy for validation and one `Buffer.concat` appends
 * the snippets — and `code` in the result is a `Buffer` a load hook can
 * return as-is. Decoding the source to a JS string (and sending it back
 * across napi as UTF-16) would cost O(n) per module for a few appended
 * bytes. Wrap entries regenerate the whole module, so a buffer source falls
 * back to one decode and the string path.
 *
 * @param {string | Buffer | ArrayBuffer | NodeJS.TypedArray} source
 * @param {import('./config.mjs').InstrumentEntry[]} entries
 * @param {string} idOrUrl
 * @param {{ format?: string, delivery?: 'import' | 'registry' }} [options]
 * @returns {{ code: string | Buffer, map: string | null } | null} null when
 *   nothing applies or the source is already instrumented
 */
export function applyMatched(source, entries, idOrUrl, options = {}) {
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) {
    // zero-copy views, not copies: Buffer.from(ArrayBuffer) aliases the memory
    source = ArrayBuffer.isView(source)
      ? Buffer.from(source.buffer, source.byteOffset, source.byteLength)
      : Buffer.from(source)
  }
  // works on both: Buffer#includes(string) is a UTF-8 byte search
  if (entries.length === 0 || source.includes(SENTINEL_TEXT)) {
    return null
  }
  const kind = moduleKindFor(idOrUrl, options.format)
  const registry = options.delivery === 'registry'
  if (Buffer.isBuffer(source)) {
    if (entries.every((entry) => entry.patch)) {
      return applyPatchesToBuffer(source, entries, kind, registry)
    }
    source = source.toString('utf8')
  }
  const ordered = [...entries].sort((a, b) => (a.patch ? 1 : 0) - (b.patch ? 1 : 0))
  let code = source
  let map = null
  let aliasIndex = 0
  for (const entry of ordered) {
    if (entry.patch) {
      // Only the snippet crosses the napi boundary; for CJS not even the
      // source does (no static validation there) — round-tripping the module
      // text cost two O(n) string conversions for a few appended bytes.
      const cjs = kind === 'cjs'
      code += exportsTapSnippet(
        cjs ? '' : code,
        entry.bindings,
        entry.patch.name,
        entry.patch.from,
        cjs,
        registry,
        aliasIndex,
      )
      aliasIndex += 1
    } else {
      const filename = basename(cleanPath(idOrUrl))
      const wrapped = transformLambdaWithMapObject(code, entry.handler, entry.wrapper.name, filename)
      code = wrapped.code
      if (entry.wrapper.from) {
        code += `\nimport { ${entry.wrapper.name} } from ${JSON.stringify(entry.wrapper.from)};`
      }
      map = wrapped.map ?? null
    }
  }
  code += `\n${SENTINEL}\n`
  return { code, map }
}

/**
 * Patch-only fast path of {@link applyMatched}: the module source never
 * leaves UTF-8. Each entry validates against the original source (taps only
 * append — they never add or remove exports, so validating against the
 * evolving text like the string path does would resolve identically), and a
 * single `Buffer.concat` performs every append at once. The snippets
 * themselves travel as strings: a few hundred bytes each, they cost far less
 * to convert than the module source whose conversions this path exists to
 * avoid.
 */
function applyPatchesToBuffer(source, entries, kind, registry) {
  const cjs = kind === 'cjs'
  let appended = ''
  let aliasIndex = 0
  for (const entry of entries) {
    appended += cjs
      ? // CJS taps need no static validation — no source crosses napi at all
        exportsTapSnippet('', entry.bindings, entry.patch.name, entry.patch.from, true, registry, aliasIndex)
      : exportsTapSnippetFromBuffer(
          source,
          entry.bindings,
          entry.patch.name,
          entry.patch.from,
          false,
          registry,
          aliasIndex,
        )
    aliasIndex += 1
  }
  return { code: Buffer.concat([source, Buffer.from(`${appended}\n${SENTINEL}\n`)]), map: null }
}

/** Inline a v3 map JSON as a trailing `//# sourceMappingURL=` data URL. */
export function inlineMap(code, mapJson) {
  const base64 = Buffer.from(mapJson, 'utf8').toString('base64')
  return `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`
}
