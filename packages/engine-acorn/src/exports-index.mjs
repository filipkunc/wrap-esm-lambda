// One pass over an acorn program body collecting everything the binding
// resolver needs to know about a module's exports — the JS mirror of the
// Rust `build_export_index`. Nodes are kept by reference (not index): the
// rewrite step edits the source text through the nodes' spans.
import { parse } from 'acorn'

/** Parse a module the way oxc's `SourceType::mjs()` does. */
export function parseModule(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
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

/** The name of an import/export specifier position (`Identifier` or string `Literal`). */
export function specifierName(node) {
  return node.type === 'Identifier' ? node.name : String(node.value)
}

/**
 * Every name a binding pattern declares: identifiers, object/array
 * destructuring (including defaults and rest), recursively —
 * `export const { a, b: [c], ...rest } = obj` exports `a`, `c` and `rest`.
 */
export function collectBoundNames(pattern, out) {
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

/**
 * Everything the resolver needs to know about a module's exports.
 *
 * @param {import('acorn').Program} program
 * @returns {{
 *   named: {
 *     exported: string, local: string, kind: string,
 *     stmt: object, specIdx: number, declNode: object | null, source: string | null,
 *   }[],
 *   default: { local: string } | { anonStmt: object } | null,
 *   importLocals: Set<string>,
 *   topConst: Map<string, object>,
 *   starSources: string[],
 * }}
 */
export function buildExportIndex(program) {
  const index = {
    named: [],
    default: null,
    importLocals: new Set(),
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
          index.importLocals.add(spec.local.name)
        }
        break
      case 'VariableDeclaration':
        if (stmt.kind === 'const') {
          const names = []
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
        if (stmt.exported === null) {
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
        const named = (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id !== null
        // a named default declaration is a live alias of its mutable local
        // binding; anything else needs the rewrite that names it
        index.default = named ? { local: decl.id.name } : { anonStmt: stmt }
        break
      }
      default:
        break
    }
  }
  return index
}

function indexDeclarationExport(index, stmt) {
  const decl = stmt.declaration
  switch (decl.type) {
    case 'VariableDeclaration': {
      const constant = decl.kind === 'const'
      const names = []
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

/**
 * The statically visible surface of an ESM module: every exported name
 * (including `default` and `export * as ns` names) plus the specifiers of
 * bare `export * from` statements — the building block of the caller's
 * star-graph walk. Mirrors the native `esmModuleExports`.
 */
export function esmModuleExports(input) {
  const index = buildExportIndex(parseModule(input))
  const names = index.named.map((info) => info.exported)
  if (index.default !== null) names.push('default')
  return { names, starSources: index.starSources }
}
