// The generic "exports tap" — the pure-JS twin of the native oxc
// implementation (src/transform.rs). Same contract, same emitted snippets
// (byte-identical), same fast-path/rewrite split. The one deliberate
// difference is HOW the rewrite path edits the module: the native engine
// regenerates the whole program through oxc codegen, while this engine makes
// surgical magic-string edits (demote a keyword, replace one statement,
// append statements), so untouched lines keep their exact source text and
// the emitted map stays sparse.
import MagicString from 'magic-string'
import { NamedKind, buildExportIndex, parseModule } from './exports-index.mjs'
import { braceName, buildSnippet, quoteJsString, starStub } from './snippets.mjs'
import { chainMaps } from './sourcemaps.mjs'

/**
 * Deterministic fresh identifiers: `__wel_l0`, `__wel_l1`, ... skipping any
 * name the source already mentions (a conservative substring check — a false
 * positive only burns a suffix). Determinism matters: build-time and runtime
 * delivery must emit byte-identical modules.
 */
class FreshNames {
  constructor(source) {
    this.source = source
    this.counter = 0
  }

  /** Numbered from zero: `__wel_l0`, `__wel_l1`, ... — for the split locals. */
  numbered(prefix) {
    for (;;) {
      const candidate = `${prefix}${this.counter}`
      this.counter += 1
      if (!this.source.includes(candidate)) return candidate
    }
  }

  /** The bare hint when free (`__wel_default`), numbered otherwise. */
  named(hint) {
    if (!this.source.includes(hint)) return hint
    for (let n = 0; ; n += 1) {
      const candidate = `${hint}${n}`
      if (!this.source.includes(candidate)) return candidate
    }
  }
}

/** @returns {{ exported: string, local: string, reassignable: boolean, verifySet: boolean }} */
function accessor(exported, local, verifySet = false) {
  return { exported, local, reassignable: true, verifySet }
}

/**
 * The restructurings the resolver accumulated, applied in one pass over the
 * source text. All ops are deduplicated — several entries tapping the same
 * binding converge on identical rewrites.
 */
function emptyOps() {
  return {
    /** @type {Set<object>} VariableDeclaration nodes demoted `const` -> `let` */
    demote: new Set(),
    /** @type {{ stmt: object, ident: string } | null} the anonymous `export default` */
    defaultAnon: null,
    /** @type {{ stmt: object, specIdx: number, exported: string, imported: string, source: string | null, localIdent: string }[]} */
    splits: [],
    /** @type {{ stmt: object, exported: string, source: string, localIdent: string }[]} */
    nsSplits: [],
  }
}

function opsAreEmpty(ops) {
  return ops.demote.size === 0 && ops.defaultAnon === null && ops.splits.length === 0 && ops.nsSplits.length === 0
}

/**
 * Register (or reuse) the split of an export specifier into a rebindable
 * local, keyed on the specifier's position so several entries converge on
 * one split.
 */
function splitLocal(ops, fresh, info) {
  const existing = ops.splits.find((s) => s.stmt === info.stmt && s.specIdx === info.specIdx)
  if (existing) return existing.localIdent
  const localIdent = fresh.numbered('__wel_l')
  ops.splits.push({
    stmt: info.stmt,
    specIdx: info.specIdx,
    exported: info.exported,
    imported: info.local,
    source: info.source,
    localIdent,
  })
  return localIdent
}

/**
 * Resolve one requested binding name against the export index, recording any
 * rewrite it needs. Returns the local identifier the accessor closes over.
 * Every resolved binding is reassignable — that is the point of the rewrite
 * path; the only refusal left is a name that does not exist (thrown with the
 * same message the native engine produces — callers match on it).
 */
function resolveBinding(name, index, ops, fresh) {
  const info = index.named.find((entry) => entry.exported === name)
  if (info) {
    switch (info.kind) {
      case NamedKind.DeclMutable:
        return info.local
      case NamedKind.DeclConst:
        ops.demote.add(info.declNode)
        return info.local
      case NamedKind.ListLocal: {
        if (index.importLocals.has(info.local)) {
          // import bindings can never be reassigned — snapshot into a `let`
          return splitLocal(ops, fresh, info)
        }
        const constDecl = index.topConst.get(info.local)
        if (constDecl !== undefined) ops.demote.add(constDecl)
        return info.local
      }
      case NamedKind.ReExport:
        return splitLocal(ops, fresh, info)
      case NamedKind.ReExportAll: {
        const existing = ops.nsSplits.find((s) => s.stmt === info.stmt)
        if (existing) return existing.localIdent
        const localIdent = fresh.numbered('__wel_l')
        ops.nsSplits.push({ stmt: info.stmt, exported: info.exported, source: info.source, localIdent })
        return localIdent
      }
      default:
        throw new Error(`internal: unknown export kind '${info.kind}'`)
    }
  }
  if (name === 'default' && index.default !== null) {
    if ('local' in index.default) return index.default.local
    if (ops.defaultAnon !== null) return ops.defaultAnon.ident
    const ident = fresh.named('__wel_default')
    ops.defaultAnon = { stmt: index.default.anonStmt, ident }
    return ident
  }
  const available = index.named.map((entry) => entry.exported)
  if (index.default !== null) available.push('default')
  const starHint =
    index.starSources.length === 0 ? '' : `; unresolved 'export *' sources: ${index.starSources.join(', ')}`
  throw new Error(`export '${name}' not found in module (available: ${available.join(', ')}${starHint})`)
}

/** `export { a, b as c } from "m";` regenerated for the specifiers that remain. */
function exportStatementText(specs, source) {
  const list = specs
    .map(({ local, exported }) =>
      local === exported ? braceName(local) : `${braceName(local)} as ${braceName(exported)}`,
    )
    .join(', ')
  const braces = list.length === 0 ? '{}' : `{ ${list} }`
  const from = source === null ? '' : ` from ${quoteJsString(source)}`
  return `export ${braces}${from};`
}

/**
 * Apply the accumulated rewrites as magic-string edits:
 * - demotions overwrite the `const` keyword with `let` where it stands;
 * - the anonymous default keeps its expression *at its position* (evaluation
 *   order and side effects preserved) — only the `export default ` prefix
 *   becomes `let <ident> = `, with `export { <ident> as default };` appended;
 * - split specifiers are removed from their export statement (the statement
 *   itself is kept, even if emptied — `export {} from "m"` still triggers
 *   the source module's load) and re-created at the end of the module as an
 *   optional import alias, a `let` snapshot, and an `export { local as
 *   exported };`. The snapshot evaluates at end-of-module, after every
 *   declaration it can reference.
 */
function applyRewrites(ms, input, ops, index) {
  for (const decl of ops.demote) {
    ms.overwrite(decl.start, decl.start + 'const'.length, 'let')
  }

  const appended = []

  if (ops.defaultAnon !== null) {
    const { stmt, ident } = ops.defaultAnon
    ms.overwrite(stmt.start, stmt.declaration.start, `let ${ident} = `)
    appended.push(`export { ${ident} as default };`)
  }

  // group split specifier removals per statement, then rebuild each list
  const byStmt = new Map()
  for (const split of ops.splits) {
    const group = byStmt.get(split.stmt) ?? []
    group.push(split)
    byStmt.set(split.stmt, group)
  }
  for (const [stmt, splits] of byStmt) {
    const removed = new Set(splits.map((s) => s.specIdx))
    const remaining = index.named
      .filter((info) => info.stmt === stmt && !removed.has(info.specIdx))
      .map(({ local, exported }) => ({ local, exported }))
    const source = splits[0].source
    ms.overwrite(stmt.start, stmt.end, exportStatementText(remaining, source))
  }
  for (const split of ops.splits) {
    let sourceLocal
    if (split.source !== null) {
      sourceLocal = `${split.localIdent}_src`
      appended.push(`import { ${braceName(split.imported)} as ${sourceLocal} } from ${quoteJsString(split.source)};`)
    } else {
      sourceLocal = split.imported
    }
    appended.push(`let ${split.localIdent} = ${sourceLocal};`)
    appended.push(`export { ${split.localIdent} as ${braceName(split.exported)} };`)
  }

  for (const ns of ops.nsSplits) {
    // the namespace import keeps the source module's load (and gives the
    // snapshot a binding); the original `export * as ns` statement is what
    // it replaces
    const importLocal = `${ns.localIdent}_src`
    ms.overwrite(ns.stmt.start, ns.stmt.end, `import * as ${importLocal} from ${quoteJsString(ns.source)};`)
    appended.push(`let ${ns.localIdent} = ${importLocal};`)
    appended.push(`export { ${ns.localIdent} as ${braceName(ns.exported)} };`)
  }

  if (appended.length > 0) {
    // no blank separator line when the source already ends in a newline —
    // keeps the edited module byte-identical to the native codegen's output
    // on conventionally formatted sources
    ms.append(`${input.endsWith('\n') ? '' : '\n'}${appended.join('\n')}\n`)
  }
}

/** The CJS tap: accessors through `module.exports`, no validation, no rewrite. */
function cjsTap(entries, registry) {
  let snippets = ''
  for (const entry of entries) {
    const accessors = entry.bindings.map((name) =>
      // Reserved binding: the whole `module.exports` — for CJS packages whose
      // exports object IS the API (express, fastify), where wrapping the
      // callable means rebinding module.exports itself. Assigning that slot
      // always works (plain writable property), so no set verification there.
      name === 'module.exports' ? accessor(name, 'module.exports') : accessor(name, `module.exports.${name}`, true),
    )
    snippets += buildSnippet(accessors, entry.patchName, entry.patchFrom, registry, entry.aliasIndex)
  }
  return { snippets, code: null, map: null }
}

/**
 * The exports tap, for every patch entry of one module in a single call (one
 * parse, at most one rewrite) — same contract as the native `exportsTap`:
 *
 * - fast path (`code: null`): every requested binding is already a
 *   reassignable module-local; only `snippets` gets appended, the source is
 *   untouched and existing maps stay valid;
 * - rewrite path (`code` set): some binding needed restructuring; `code` is
 *   the edited module and `map` its v3 source map (chained through
 *   `upstreamMap` when one was given).
 *
 * A missing export throws with the native engine's exact message — the
 * version-drift alarm, and what the star-retry in core matches on.
 *
 * @param {string} input
 * @param {{ bindings: string[], patchName: string, patchFrom: string, aliasIndex: number }[]} entries
 * @param {{ binding: string, source: string }[] | undefined} [starResolutions]
 * @returns {{ snippets: string, code: string | null, map: string | null }}
 */
export function exportsTap(input, entries, cjs, registry, filename, upstreamMap, starResolutions) {
  if (cjs) {
    return cjsTap(entries, registry)
  }

  const program = parseModule(input)
  const index = buildExportIndex(program)
  const ops = emptyOps()
  const fresh = new FreshNames(input)

  const starMap = new Map((starResolutions ?? []).map(({ binding, source }) => [binding, source]))
  const starLocals = new Map()
  let starStubs = ''

  // resolve every entry first: validation errors must fire before any
  // rewrite decision, and entries tapping the same binding share rewrites
  const entryAccessors = entries.map((entry) =>
    entry.bindings.map((name) => {
      let local
      try {
        local = resolveBinding(name, index, ops, fresh)
      } catch (err) {
        // a name the module's own exports don't have, but the caller's
        // star-graph walk located in one of the `export * from` sources:
        // reroute it through an append-only shadow export
        const source = starMap.get(name)
        if (source === undefined) throw err
        local = starLocals.get(name)
        if (local === undefined) {
          local = fresh.numbered('__wel_l')
          starStubs += starStub(name, source, local)
          starLocals.set(name, local)
        }
      }
      // ESM locals are strict-mode bindings; after resolution every local
      // is reassignable, so no set verification is needed
      return accessor(name, local)
    }),
  )

  let snippets = starStubs
  entries.forEach((entry, i) => {
    snippets += buildSnippet(entryAccessors[i], entry.patchName, entry.patchFrom, registry, entry.aliasIndex)
  })

  if (opsAreEmpty(ops)) {
    return { snippets, code: null, map: null }
  }

  const ms = new MagicString(input)
  applyRewrites(ms, input, ops, index)
  let map = null
  if (filename != null) {
    const rewriteMap = ms.generateMap({ source: filename, hires: 'boundary', includeContent: true })
    map = upstreamMap != null ? chainMaps(rewriteMap, upstreamMap) : rewriteMap.toString()
  }
  return { snippets, code: ms.toString(), map }
}

/**
 * Buffer-input twin of `exportsTap`, mirroring the native API. The native
 * engine crosses napi zero-copy here; a JS engine has no boundary to save,
 * so this is a plain decode — the honest cost of the JS-only setup, and
 * exactly what the JS-vs-Rust benchmark measures.
 */
export function exportsTapFromBuffer(input, entries, cjs, registry, filename, upstreamMap, starResolutions) {
  const source = cjs ? '' : input.toString('utf8')
  return exportsTap(source, entries, cjs, registry, filename, upstreamMap, starResolutions)
}
