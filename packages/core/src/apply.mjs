// The apply step: turn matched entries into instrumented source, via the
// native `wrap-esm-lambda` oxc addon. Both shells call `applyMatched`, so
// the instrumented output is byte-identical whichever mode produced it.
import { basename } from 'node:path'
import { transformLambdaWithMapObject, exportsTap, exportsTapFromBuffer, esmModuleExports } from 'wrap-esm-lambda'
import { cleanPath } from './paths.mjs'
import { moduleKindFor } from './format.mjs'
import { resolveStarBindings } from './stars.mjs'

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

/** The tap inputs for the native call, one element per patch entry. */
function tapEntries(patches) {
  return patches.map((entry, aliasIndex) => ({
    bindings: entry.bindings,
    patchName: entry.patch.name,
    patchFrom: entry.patch.from,
    aliasIndex,
  }))
}

/**
 * The native tap call, with one retry for names forwarded by bare
 * `export * from` statements. Such names are invisible in the module's own
 * source, so the first call fails not-found; the transform then reads and
 * parses the star sources (relative specifiers only, recursively) to learn
 * which one provides each missing name, and retries with that provenance —
 * the tap reroutes those names through append-only shadow exports. Names no
 * star source provides rethrow the original loud error; ambiguous names
 * (two sources — importers cannot link them either) throw their own.
 *
 * `tap` is the native function to use (string or buffer variant), `decode`
 * lazily yields the source text for the walk.
 */
function tapWithStarRetry(tap, decode, modulePath, entriesInput, cjs, registry, filename, upstreamMap) {
  try {
    return tap(entriesInput, cjs, registry, filename, upstreamMap, undefined)
  } catch (err) {
    if (cjs || !/not found in module/.test(String(err?.message))) throw err
    const sourceText = decode()
    const { names, starSources } = esmModuleExports(sourceText)
    if (starSources.length === 0) throw err
    const known = new Set(names)
    const missing = new Set(entriesInput.flatMap((entry) => entry.bindings).filter((name) => !known.has(name)))
    const resolutions = resolveStarBindings(missing, starSources, modulePath)
    if (resolutions.length === 0) throw err
    return tap(entriesInput, cjs, registry, filename, upstreamMap, resolutions)
  }
}

/**
 * Apply every matching entry to a module, in one pass shared by both shells.
 * Wrap entries run first (they re-generate the whole module); the patch
 * entries then go to the native exports tap in a single call — one parse for
 * all of them. The sentinel lands once at the end.
 *
 * The tap itself is tiered: bindings that are already reassignable locals
 * cost only an appended snippet, while shapes that need restructuring
 * (`export const`, an anonymous `export default`, re-exports, import-backed
 * list exports) come back as a regenerated module plus a source map — which
 * is chained through the wrap map when a wrap entry ran first.
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
 * patch-only matches that stay on the tap's fast path the source then never
 * leaves UTF-8 — it crosses napi zero-copy for validation and one
 * `Buffer.concat` appends the snippets — and `code` in the result is a
 * `Buffer` a load hook can return as-is. When the tap has to rewrite, the
 * regenerated module comes back as a string (that O(n) is the price of the
 * shapes that need it, paid only by modules that need it).
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
  const cjs = kind === 'cjs'
  const registry = options.delivery === 'registry'
  const filename = basename(cleanPath(idOrUrl))
  const wraps = entries.filter((entry) => !entry.patch)
  const patches = entries.filter((entry) => entry.patch)

  if (Buffer.isBuffer(source)) {
    if (wraps.length === 0) {
      // patch-only buffer fast path: the source crosses napi zero-copy; only
      // when the tap must rewrite does it come back as a (string) module
      const buf = source
      const tap = tapWithStarRetry(
        (entriesInput, ...rest) => exportsTapFromBuffer(cjs ? EMPTY_BUFFER : buf, entriesInput, ...rest),
        () => buf.toString('utf8'),
        cleanPath(idOrUrl),
        tapEntries(patches),
        cjs,
        registry,
        filename,
        undefined,
      )
      const trailer = `${tap.snippets}\n${SENTINEL}\n`
      if (tap.code == null) {
        return { code: Buffer.concat([source, Buffer.from(trailer)]), map: null }
      }
      return { code: tap.code + trailer, map: tap.map ?? null }
    }
    source = source.toString('utf8')
  }

  let code = source
  let map = null
  for (const entry of wraps) {
    const wrapped = transformLambdaWithMapObject(code, entry.handler, entry.wrapper.name, filename)
    code = wrapped.code
    if (entry.wrapper.from) {
      code += `\nimport { ${entry.wrapper.name} } from ${JSON.stringify(entry.wrapper.from)};`
    }
    map = wrapped.map ?? null
  }
  if (patches.length > 0) {
    // one native call for all patch entries; a wrap map chains through any
    // tap rewrite so the final map still reaches the original source
    const text = code
    const tap = tapWithStarRetry(
      (entriesInput, ...rest) => exportsTap(cjs ? '' : text, entriesInput, ...rest),
      () => text,
      cleanPath(idOrUrl),
      tapEntries(patches),
      cjs,
      registry,
      filename,
      map ?? undefined,
    )
    if (tap.code != null) {
      code = tap.code
      map = tap.map ?? null
    }
    code += tap.snippets
  }
  code += `\n${SENTINEL}\n`
  return { code, map }
}

const EMPTY_BUFFER = Buffer.alloc(0)

/** Inline a v3 map JSON as a trailing `//# sourceMappingURL=` data URL. */
export function inlineMap(code, mapJson) {
  const base64 = Buffer.from(mapJson, 'utf8').toString('base64')
  return `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`
}
