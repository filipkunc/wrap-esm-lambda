// One pass over an acorn program body collecting everything the binding
// resolver needs to know about a module's exports — the JS mirror of the
// Rust `build_export_index`. Nodes are kept by reference (not index): the
// rewrite step edits the source text through the nodes' spans.
import { parse } from 'acorn'
import type {
  AnyNode,
  ClassDeclaration,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  FunctionDeclaration,
  Identifier,
  Literal,
  Pattern,
  Program,
  VariableDeclaration,
} from 'acorn'

/** Parse a module the way oxc's `SourceType::mjs()` does. */
export function parseModule(source: string): Program {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
}

/**
 * `import.meta` anywhere in the tree (a `MetaProperty` whose meta is
 * `import`). The walk is structural rather than typed — it visits every own
 * key of every node — so it takes `unknown` and narrows as it goes.
 */
function containsImportMeta(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(containsImportMeta)
  const record = node as Record<string, unknown>
  if (record.type === 'MetaProperty') return (record.meta as Identifier).name === 'import'
  for (const key in record) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    if (containsImportMeta(record[key])) return true
  }
  return false
}

/**
 * Does the source contain ESM module syntax — `import`/`export` statements
 * or `import.meta`? The same question Node's own format detection and every
 * bundler's syntax sniffing answer for a `.js` file with no `"type"` field;
 * core's CJS-or-ESM fallback at build time keys on it. A source that fails
 * to parse as ESM reports `false`: whatever it is, the ESM tap cannot read
 * it. (A dynamic `import()` alone is valid CJS and does not count — matching
 * the native engine's oxc `has_module_syntax` semantics exactly.)
 */
export function hasModuleSyntax(input: string): boolean {
  let program: Program
  try {
    program = parseModule(input)
  } catch {
    return false
  }
  for (const stmt of program.body) {
    switch (stmt.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
        return true
      default:
        break
    }
  }
  return containsImportMeta(program)
}

/** How a named export reaches its value, as far as static analysis sees. */
export const NamedKind = Object.freeze({
  /** `export let/var/function/class X` — a mutable module-local binding. */
  DeclMutable: 'decl-mutable',
  /** `export const X = ...` — rebindable only after demoting to `let`. */
  DeclConst: 'decl-const',
  /** `export { a as b }` with no source — resolved through top-level decls. */
  ListLocal: 'list-local',
  /** `export { a as b } from "m"` — no local binding; tapping means a split. */
  ReExport: 're-export',
  /** `export * as ns from "m"` — the namespace object under a static name. */
  ReExportAll: 're-export-all',
})

/** One of NamedKind's values. */
export type NamedKindValue = (typeof NamedKind)[keyof typeof NamedKind]

/** The statement a named export was found on. */
export type ExportStatement = ExportNamedDeclaration | ExportAllDeclaration

/** One named export, with the nodes the rewrite step edits through. */
export interface NamedExport {
  exported: string
  local: string
  kind: NamedKindValue
  stmt: ExportStatement
  specIdx: number
  declNode: VariableDeclaration | FunctionDeclaration | ClassDeclaration | null
  source: string | null
}

/** `export default someLocal` — a live alias of a mutable local binding. */
export interface DefaultLocal {
  local: string
  anonStmt?: undefined
}

/** `export default <expression>` — needs the rewrite that names it. */
export interface DefaultAnonymous {
  anonStmt: AnyNode
  local?: undefined
}

/** Where an imported local binding comes from: the module specifier and the
 * name imported from it (`*` for a namespace import, `default` for a
 * default import) — recorded so `esmModuleExports` can report the true
 * origin of import-backed list exports. */
export interface ImportOrigin {
  source: string
  imported: string
}

/** Everything the binding resolver needs to know about a module's exports. */
export interface ExportIndex {
  named: NamedExport[]
  default: DefaultLocal | DefaultAnonymous | null
  importLocals: Map<string, ImportOrigin>
  topConst: Map<string, VariableDeclaration>
  starSources: string[]
}

/** The name of an import/export specifier position (`Identifier` or string `Literal`). */
export function specifierName(node: Identifier | Literal): string {
  return node.type === 'Identifier' ? node.name : String(node.value)
}

/**
 * Every name a binding pattern declares: identifiers, object/array
 * destructuring (including defaults and rest), recursively —
 * `export const { a, b: [c], ...rest } = obj` exports `a`, `c` and `rest`.
 */
export function collectBoundNames(pattern: Pattern, out: string[]): void {
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name)
      break
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        collectBoundNames(property.type === 'RestElement' ? property.argument : property.value, out)
      }
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) {
        if (element !== null) collectBoundNames(element, out)
      }
      break
    case 'RestElement':
      collectBoundNames(pattern.argument, out)
      break
    case 'AssignmentPattern':
      collectBoundNames(pattern.left, out)
      break
    default:
      break
  }
}

/** Everything the resolver needs to know about a module's exports. */
export function buildExportIndex(program: Program): ExportIndex {
  const index: ExportIndex = {
    named: [],
    default: null,
    importLocals: new Map(),
    // top-level `const` declarations (exported directly or not) by name →
    // their VariableDeclaration node, for demotion of list-exported consts
    topConst: new Map(),
    // specifiers of bare `export * from "m"` statements — names these
    // forward are not statically visible from this module alone
    starSources: [],
  }
  for (const stmt of program.body) {
    switch (stmt.type) {
      case 'ImportDeclaration':
        for (const spec of stmt.specifiers) {
          index.importLocals.set(spec.local.name, {
            source: String(stmt.source.value),
            imported:
              spec.type === 'ImportSpecifier'
                ? specifierName(spec.imported)
                : spec.type === 'ImportDefaultSpecifier'
                  ? 'default'
                  : '*',
          })
        }
        break
      case 'VariableDeclaration':
        if (stmt.kind === 'const') {
          const names: string[] = []
          for (const decl of stmt.declarations) collectBoundNames(decl.id, names)
          for (const name of names) index.topConst.set(name, stmt)
        }
        break
      case 'ExportNamedDeclaration':
        if (stmt.declaration) {
          indexDeclarationExport(index, stmt)
        } else {
          const source = stmt.source ? String(stmt.source.value) : null
          stmt.specifiers.forEach((specifier, specIdx) => {
            index.named.push({
              exported: specifierName(specifier.exported),
              local: specifierName(specifier.local),
              kind: source !== null ? NamedKind.ReExport : NamedKind.ListLocal,
              stmt,
              specIdx,
              declNode: null,
              source,
            })
          })
        }
        break
      case 'ExportAllDeclaration':
        // `export * as ns from "m"` has a statically visible name; a bare
        // `export * from "m"` only records its source for the star-graph walk
        // (`== null`: acorn types the absent case as null, older typings as
        // undefined — both mean "bare star")
        if (stmt.exported == null) {
          index.starSources.push(String(stmt.source.value))
        } else {
          const name = specifierName(stmt.exported)
          index.named.push({
            exported: name,
            local: name,
            kind: NamedKind.ReExportAll,
            stmt,
            specIdx: 0,
            declNode: null,
            source: String(stmt.source.value),
          })
        }
        break
      case 'ExportDefaultDeclaration': {
        const decl = stmt.declaration
        // a named default declaration is a live alias of its mutable local
        // binding; anything else needs the rewrite that names it
        index.default =
          (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id !== null
            ? { local: decl.id.name }
            : { anonStmt: stmt }
        break
      }
      default:
        break
    }
  }
  return index
}

function indexDeclarationExport(index: ExportIndex, stmt: ExportNamedDeclaration): void {
  const decl = stmt.declaration
  if (decl === null || decl === undefined) return
  switch (decl.type) {
    case 'VariableDeclaration': {
      const constant = decl.kind === 'const'
      const names: string[] = []
      for (const declarator of decl.declarations) collectBoundNames(declarator.id, names)
      for (const name of names) {
        if (constant) index.topConst.set(name, decl)
        index.named.push({
          exported: name,
          local: name,
          kind: constant ? NamedKind.DeclConst : NamedKind.DeclMutable,
          stmt,
          specIdx: 0,
          declNode: decl,
          source: null,
        })
      }
      break
    }
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      if (decl.id !== null) {
        index.named.push({
          exported: decl.id.name,
          local: decl.id.name,
          kind: NamedKind.DeclMutable,
          stmt,
          specIdx: 0,
          declNode: decl,
          source: null,
        })
      }
      break
    default:
      break
  }
}

/** One re-exported name with its provenance — the JS mirror of the native
 * `EsmReexport`: `exported` is the consumer-visible name, `imported` the
 * name taken from `source` (`*` for a namespace re-export). */
export interface EsmReexport {
  exported: string
  imported: string
  source: string
}

/**
 * The statically visible surface of an ESM module: every exported name
 * (including `default` and `export * as ns` names), the specifiers of bare
 * `export * from` statements, plus the provenance of every export that
 * resolves into another module (`reexports`) — explicit re-exports,
 * namespace re-exports, and list exports of import-backed locals
 * (`import { x } from "m"; export { x }` — the binding is m's, exactly as
 * if written `export { x } from "m"`). The building blocks of the caller's
 * star-graph walk and its ResolveExport-style same-binding comparison.
 * Mirrors the native `esmModuleExports`.
 */
export function esmModuleExports(input: string): {
  names: string[]
  starSources: string[]
  reexports: EsmReexport[]
} {
  const index = buildExportIndex(parseModule(input))
  const names = index.named.map((info) => info.exported)
  if (index.default !== null) names.push('default')
  const reexports: EsmReexport[] = []
  for (const info of index.named) {
    if (info.kind === NamedKind.ReExport && info.source !== null) {
      reexports.push({ exported: info.exported, imported: info.local, source: info.source })
    } else if (info.kind === NamedKind.ReExportAll && info.source !== null) {
      reexports.push({ exported: info.exported, imported: '*', source: info.source })
    } else if (info.kind === NamedKind.ListLocal) {
      const origin = index.importLocals.get(info.local)
      if (origin !== undefined) {
        reexports.push({ exported: info.exported, imported: origin.imported, source: origin.source })
      }
    }
  }
  return { names, starSources: index.starSources, reexports }
}
