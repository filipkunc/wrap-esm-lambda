//! One static pass over a module's program body, indexing everything the
//! binding resolver needs to know about its exports: every named export and
//! how it reaches its value, the default export's shape, import-backed
//! locals with their origin, top-level `const` declarations, and the
//! sources of bare `export * from` statements.

use oxc_ast::ast::{
  BindingPattern, Declaration, ImportDeclarationSpecifier, Program, Statement,
  VariableDeclarationKind,
};

/// How a named export reaches its value, as far as static analysis sees.
pub(crate) enum NamedKind {
  /// `export let/var/function/class X` — a mutable module-local binding.
  DeclMutable,
  /// `export const X = ...` — rebindable only after demoting the
  /// declaration to `let` (a rewrite).
  DeclConst,
  /// `export { a as b }` with no source — resolved through the module's
  /// top-level declarations: mutable locals need nothing, `const` locals a
  /// demotion, import-backed locals a snapshot split (import bindings can
  /// never be reassigned).
  ListLocal,
  /// `export { a as b } from "m"` — no local binding at all; tapping it
  /// means splitting the specifier into an import plus a rebindable local
  /// (a rewrite, with documented snapshot semantics).
  ReExport,
  /// `export * as ns from "m"` — the namespace object under a static name;
  /// tapping it replaces the statement with a namespace import plus a
  /// rebindable local (a rewrite, same snapshot semantics).
  ReExportAll,
}

/// Every name a binding pattern declares: identifiers, object/array
/// destructuring (including defaults and rest), recursively —
/// `export const { a, b: [c], ...rest } = obj` exports `a`, `c` and `rest`.
fn collect_bound_names(pattern: &BindingPattern, out: &mut Vec<String>) {
  match pattern {
    BindingPattern::BindingIdentifier(ident) => out.push(ident.name.to_string()),
    BindingPattern::ObjectPattern(object) => {
      for property in &object.properties {
        collect_bound_names(&property.value, out);
      }
      if let Some(rest) = &object.rest {
        collect_bound_names(&rest.argument, out);
      }
    }
    BindingPattern::ArrayPattern(array) => {
      for element in array.elements.iter().flatten() {
        collect_bound_names(element, out);
      }
      if let Some(rest) = &array.rest {
        collect_bound_names(&rest.argument, out);
      }
    }
    BindingPattern::AssignmentPattern(assignment) => collect_bound_names(&assignment.left, out),
  }
}

pub(crate) struct NamedInfo {
  pub(crate) exported: String,
  pub(crate) local: String,
  pub(crate) kind: NamedKind,
  pub(crate) stmt_idx: usize,
  pub(crate) spec_idx: usize,
  /// the module specifier for `ReExport` entries, `None` otherwise
  pub(crate) source: Option<String>,
}

/// Where an imported local binding comes from: the module specifier and the
/// name imported from it (`*` for a namespace import, `default` for a
/// default import). Recorded so `esm_module_exports` can report the true
/// origin of import-backed list exports — `import { x } from "m"; export
/// { x }` resolves to m's `x` per ResolveExport, exactly like `export { x }
/// from "m"` does.
pub(crate) struct ImportOrigin {
  pub(crate) source: String,
  pub(crate) imported: String,
}

pub(crate) enum DefaultInfo {
  /// `export default function f() {}` / `class C {}` — the default export is
  /// a live alias of the mutable local binding `f`/`C`; append-only works.
  Named(String),
  /// Anonymous declaration or arbitrary expression — a `*default*` binding
  /// with no name to reach it by; tapping it requires the rewrite that names
  /// it (`let __wel_default = <expr>; export { __wel_default as default };`).
  Anon(usize),
}

/// Everything the resolver needs to know about a module's exports, from one
/// pass over the program body.
pub(crate) struct ExportIndex {
  pub(crate) named: Vec<NamedInfo>,
  pub(crate) default: Option<DefaultInfo>,
  pub(crate) import_locals: std::collections::HashMap<String, ImportOrigin>,
  /// top-level `const` declarations (exported directly or not) by name →
  /// statement index, for demotion of list-exported consts
  pub(crate) top_const: std::collections::HashMap<String, usize>,
  /// specifiers of bare `export * from "m"` statements — names these forward
  /// are not statically visible from this module alone; the caller may walk
  /// them (see `esm_module_exports`) and retry with star resolutions
  pub(crate) star_sources: Vec<String>,
}

pub(crate) fn build_export_index(program: &Program) -> ExportIndex {
  let mut index = ExportIndex {
    named: Vec::new(),
    default: None,
    import_locals: std::collections::HashMap::new(),
    top_const: std::collections::HashMap::new(),
    star_sources: Vec::new(),
  };
  for (stmt_idx, stmt) in program.body.iter().enumerate() {
    match stmt {
      Statement::ImportDeclaration(import) => {
        if let Some(specifiers) = &import.specifiers {
          for spec in specifiers {
            let imported = match spec {
              ImportDeclarationSpecifier::ImportSpecifier(named) => {
                named.imported.name().to_string()
              }
              ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => "default".to_string(),
              ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => "*".to_string(),
            };
            index.import_locals.insert(
              spec.local().name.to_string(),
              ImportOrigin {
                source: import.source.value.to_string(),
                imported,
              },
            );
          }
        }
      }
      Statement::VariableDeclaration(var) if var.kind == VariableDeclarationKind::Const => {
        let mut names = Vec::new();
        for decl in &var.declarations {
          collect_bound_names(&decl.id, &mut names);
        }
        for name in names {
          index.top_const.insert(name, stmt_idx);
        }
      }
      Statement::ExportNamedDeclaration(export) => {
        if let Some(declaration) = &export.declaration {
          match declaration {
            Declaration::VariableDeclaration(var) => {
              let constant = var.kind == VariableDeclarationKind::Const;
              let mut names = Vec::new();
              for decl in &var.declarations {
                collect_bound_names(&decl.id, &mut names);
              }
              for name in names {
                if constant {
                  index.top_const.insert(name.clone(), stmt_idx);
                }
                index.named.push(NamedInfo {
                  exported: name.clone(),
                  local: name,
                  kind: if constant {
                    NamedKind::DeclConst
                  } else {
                    NamedKind::DeclMutable
                  },
                  stmt_idx,
                  spec_idx: 0,
                  source: None,
                });
              }
            }
            Declaration::FunctionDeclaration(func) => {
              if let Some(name) = func.name() {
                index.named.push(NamedInfo {
                  exported: name.to_string(),
                  local: name.to_string(),
                  kind: NamedKind::DeclMutable,
                  stmt_idx,
                  spec_idx: 0,
                  source: None,
                });
              }
            }
            Declaration::ClassDeclaration(class) => {
              if let Some(ident) = &class.id {
                index.named.push(NamedInfo {
                  exported: ident.name.to_string(),
                  local: ident.name.to_string(),
                  kind: NamedKind::DeclMutable,
                  stmt_idx,
                  spec_idx: 0,
                  source: None,
                });
              }
            }
            _ => {}
          }
        } else {
          let source = export.source.as_ref().map(|s| s.value.to_string());
          for (spec_idx, specifier) in export.specifiers.iter().enumerate() {
            index.named.push(NamedInfo {
              exported: specifier.exported.name().to_string(),
              local: specifier.local.name().to_string(),
              kind: if source.is_some() {
                NamedKind::ReExport
              } else {
                NamedKind::ListLocal
              },
              stmt_idx,
              spec_idx,
              source: source.clone(),
            });
          }
        }
      }
      Statement::ExportAllDeclaration(export) => {
        // `export * as ns from "m"` has a statically visible name; a bare
        // `export * from "m"` only records its source for the caller's
        // star-graph walk.
        if export.exported.is_none() {
          index.star_sources.push(export.source.value.to_string());
        }
        if let Some(exported) = &export.exported {
          let name = exported.name().to_string();
          index.named.push(NamedInfo {
            exported: name.clone(),
            local: name,
            kind: NamedKind::ReExportAll,
            stmt_idx,
            spec_idx: 0,
            source: Some(export.source.value.to_string()),
          });
        }
      }
      Statement::ExportDefaultDeclaration(export) => {
        use oxc_ast::ast::ExportDefaultDeclarationKind;
        index.default = Some(match &export.declaration {
          ExportDefaultDeclarationKind::FunctionDeclaration(func) if func.name().is_some() => {
            DefaultInfo::Named(func.name().unwrap().to_string())
          }
          ExportDefaultDeclarationKind::ClassDeclaration(class) if class.id.is_some() => {
            DefaultInfo::Named(class.id.as_ref().unwrap().name.to_string())
          }
          _ => DefaultInfo::Anon(stmt_idx),
        });
      }
      _ => {}
    }
  }
  index
}
