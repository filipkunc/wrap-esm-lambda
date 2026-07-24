// The original wrap transform — `export const handler = ...` rebound through
// `wrapper(...)` — as magic-string edits over an acorn parse: the JS twin of
// the native `LambdaTransform`. Where the native engine regenerates the
// module through oxc codegen, this engine wraps the handler's initializer in
// place, so every untouched byte (and therefore any existing source map
// line) survives verbatim.
import MagicString from 'magic-string'
import { parseModule, specifierName } from './exports-index.mjs'
import { quoteJsString } from './snippets.mjs'
import { chainMaps, mapToDataUrl } from './sourcemaps.mjs'

/**
 * `export { local as handler }` re-targets the transform at the local name —
 * the same first pass the native engine runs before touching declarations.
 */
function localHandlerName(program, handler) {
  for (const stmt of program.body) {
    if (stmt.type !== 'ExportNamedDeclaration') continue
    for (const spec of stmt.specifiers) {
      if (specifierName(spec.exported) === handler) return specifierName(spec.local)
    }
  }
  return handler
}

function wrapDeclaratorInit(ms, declarations, handler, wrapper) {
  const found = declarations.find((decl) => decl.id.type === 'Identifier' && decl.id.name === handler)
  if (!found || found.init === null) return false
  ms.appendLeft(found.init.start, `${wrapper}(`)
  ms.appendRight(found.init.end, ')')
  return true
}

/**
 * Parse `source`, wrap the handler, and return the edited MagicString (or
 * null when no handler-shaped statement matched — the input passes through
 * untouched, mirroring the native engine's no-op).
 */
function transformToMagicString(source, handlerName, wrapper) {
  const program = parseModule(source)
  const handler = localHandlerName(program, handlerName)
  const ms = new MagicString(source) // edited only when a statement matches

  for (const stmt of program.body) {
    if (stmt.type === 'VariableDeclaration') {
      // plain top-level declaration reached through an export list
      if (wrapDeclaratorInit(ms, stmt.declarations, handler, wrapper)) return ms
      continue
    }
    if (stmt.type !== 'ExportNamedDeclaration') continue

    const decl = stmt.declaration
    if (decl?.type === 'VariableDeclaration') {
      if (wrapDeclaratorInit(ms, decl.declarations, handler, wrapper)) return ms
      continue
    }
    if (decl?.type === 'FunctionDeclaration' && decl.id?.name === handler) {
      // `export function handler() {}` -> `export const handler = wrapper(function() {});`
      ms.overwrite(stmt.start, decl.start, `export const ${handler} = ${wrapper}(`)
      ms.remove(decl.id.start, decl.id.end)
      ms.appendRight(decl.end, ');')
      return ms
    }
    if (decl === null && stmt.source !== null) {
      // `export { handler } from "m"` -> import the original, export it wrapped
      const spec = stmt.specifiers.find((s) => specifierName(s.exported) === handler)
      if (!spec) continue
      const orig = `orig_${handler}`
      const from = quoteJsString(String(stmt.source.value))
      const remaining = stmt.specifiers
        .filter((s) => s !== spec)
        .map((s) => {
          const local = specifierName(s.local)
          const exported = specifierName(s.exported)
          return local === exported ? local : `${local} as ${exported}`
        })
      const lines = []
      if (remaining.length > 0) lines.push(`export { ${remaining.join(', ')} } from ${from};`)
      lines.push(`import { ${specifierName(spec.local)} as ${orig} } from ${from};`)
      lines.push(`export const ${handler} = ${wrapper}(${orig});`)
      ms.overwrite(stmt.start, stmt.end, lines.join('\n'))
      return ms
    }
  }
  return null
}

export function transformLambda(input, handler, wrapper) {
  const ms = transformToMagicString(input, handler, wrapper)
  return ms === null ? input : ms.toString()
}

/** Buffer-input twin, mirroring the native API (a plain decode in JS). */
export function transformLambdaFromBuffer(input, handler, wrapper) {
  return transformLambda(input.toString('utf8'), handler, wrapper)
}

/**
 * Returns the transformed code and the raw v3 source map JSON separately, so
 * a caller can compose the map with an upstream `.ts` -> `.js` map before
 * attaching it.
 *
 * @returns {{ code: string, map: string | null }}
 */
export function transformLambdaWithMapObject(input, handler, wrapper, filename) {
  const ms = transformToMagicString(input, handler, wrapper)
  if (ms === null) {
    // even a no-op emits an (identity) map, like the native codegen does
    const identity = new MagicString(input)
    return {
      code: input,
      map: identity.generateMap({ source: filename, hires: 'boundary', includeContent: true }).toString(),
    }
  }
  return {
    code: ms.toString(),
    map: ms.generateMap({ source: filename, hires: 'boundary', includeContent: true }).toString(),
  }
}

/** Like `transformLambdaWithMapObject`, but with the map inlined as a data URL. */
export function transformLambdaWithMap(input, handler, wrapper, filename) {
  const { code, map } = transformLambdaWithMapObject(input, handler, wrapper, filename)
  return `${code}\n//# sourceMappingURL=${mapToDataUrl(map)}\n`
}

/**
 * Like `transformLambdaWithMapObject`, but chains the wrap map through
 * `upstreamMap` (the `filename -> original` map, e.g. tsc's `handler.js ->
 * handler.ts` map), so the returned map already reaches the original source.
 *
 * @returns {{ code: string, map: string | null }}
 */
export function transformLambdaWithChainedMapObject(input, handler, wrapper, filename, upstreamMap) {
  const { code, map } = transformLambdaWithMapObject(input, handler, wrapper, filename)
  return { code, map: chainMaps(map, upstreamMap) }
}

/** Like `transformLambdaWithChainedMapObject`, with the chained map inlined. */
export function transformLambdaWithChainedMap(input, handler, wrapper, filename, upstreamMap) {
  const { code, map } = transformLambdaWithChainedMapObject(input, handler, wrapper, filename, upstreamMap)
  return `${code}\n//# sourceMappingURL=${mapToDataUrl(map)}\n`
}
