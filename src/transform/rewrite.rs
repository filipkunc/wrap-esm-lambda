//! The rewrite path: resolving requested binding names against the export
//! index (recording any restructuring they need), and applying the
//! accumulated ops to the AST — `const` demotions, naming anonymous
//! defaults, splitting re-exports and import-backed list exports into
//! rebindable locals. Everything here mutates the program; the append-only
//! fast path never enters this module.

use oxc_allocator::{Allocator, CloneIn, Vec as ArenaVec};
use oxc_ast::{
  NONE,
  ast::{
    BindingIdentifier, BindingPattern, Declaration, ExportNamedDeclaration, ExportSpecifier,
    Expression, IdentifierName, ImportDeclaration, ImportDeclarationSpecifier, ImportOrExportKind,
    ModuleExportName, Program, Statement, StringLiteral, VariableDeclaration,
    VariableDeclarationKind, VariableDeclarator,
  },
};
use oxc_span::SPAN;
use oxc_str::Ident;

use super::export_index::{DefaultInfo, ExportIndex, NamedInfo, NamedKind};
use super::snippet::is_plain_property_name;

/// The restructurings the resolver accumulated: applied in one pass, then the
/// module is re-generated through oxc codegen (with a source map). All ops
/// are deduplicated — several entries tapping the same binding converge on
/// identical rewrites.
#[derive(Default)]
pub(crate) struct RewriteOps {
  /// statement indices whose `const` declaration is demoted to `let`
  demote: std::collections::BTreeSet<usize>,
  /// anonymous `export default` statement index + the fresh local naming it
  default_anon: Option<(usize, String)>,
  /// export specifiers split into an (optional) import + rebindable local
  splits: Vec<Split>,
  /// `export * as ns from "m"` statements replaced by a namespace import +
  /// rebindable local
  ns_splits: Vec<NsSplit>,
}

struct NsSplit {
  stmt_idx: usize,
  exported: String,
  source: String,
  local_ident: String,
}

struct Split {
  stmt_idx: usize,
  spec_idx: usize,
  exported: String,
  /// the original local (no source) or the imported name (re-export)
  imported: String,
  /// `Some(specifier)` for re-exports: emit `import { imported as
  /// <local>_src } from specifier` and snapshot from that alias
  source: Option<String>,
  /// the fresh rebindable `let` the export is redirected through
  local_ident: String,
}

impl RewriteOps {
  pub(crate) fn is_empty(&self) -> bool {
    self.demote.is_empty()
      && self.default_anon.is_none()
      && self.splits.is_empty()
      && self.ns_splits.is_empty()
  }
}

/// Deterministic fresh identifiers: `__wel_l0`, `__wel_l1`, ... skipping any
/// name the source already mentions (a conservative substring check — a false
/// positive only burns a suffix). Determinism matters: build-time and runtime
/// delivery must emit byte-identical modules.
pub(crate) struct FreshNames<'s> {
  source: &'s str,
  counter: u32,
}

impl<'s> FreshNames<'s> {
  pub(crate) fn new(source: &'s str) -> Self {
    Self { source, counter: 0 }
  }
  /// Numbered from zero: `__wel_l0`, `__wel_l1`, ... — for the split locals.
  pub(crate) fn numbered(&mut self, prefix: &str) -> String {
    loop {
      let candidate = format!("{}{}", prefix, self.counter);
      self.counter += 1;
      if !self.source.contains(&candidate) {
        return candidate;
      }
    }
  }
  /// The bare hint when free (`__wel_default`), numbered otherwise.
  fn named(&self, hint: &str) -> String {
    if !self.source.contains(hint) {
      return hint.to_string();
    }
    let mut n = 0u32;
    loop {
      let candidate = format!("{}{}", hint, n);
      if !self.source.contains(&candidate) {
        return candidate;
      }
      n += 1;
    }
  }
}

/// Resolve one requested binding name against the export index, recording any
/// rewrite it needs. Returns the local identifier the accessor closes over.
/// Every resolved binding is reassignable — that is the point of the rewrite
/// path; the only refusal left is a name that does not exist.
pub(crate) fn resolve_binding(
  name: &str,
  index: &ExportIndex,
  ops: &mut RewriteOps,
  fresh: &mut FreshNames,
) -> Result<String, String> {
  if let Some(info) = index.named.iter().find(|info| info.exported == name) {
    return Ok(match info.kind {
      NamedKind::DeclMutable => info.local.clone(),
      NamedKind::DeclConst => {
        ops.demote.insert(info.stmt_idx);
        info.local.clone()
      }
      NamedKind::ListLocal => {
        if index.import_locals.contains_key(&info.local) {
          // import bindings can never be reassigned — snapshot into a `let`
          split_local(ops, fresh, info)
        } else {
          if let Some(&stmt_idx) = index.top_const.get(&info.local) {
            ops.demote.insert(stmt_idx);
          }
          info.local.clone()
        }
      }
      NamedKind::ReExport => split_local(ops, fresh, info),
      NamedKind::ReExportAll => {
        if let Some(existing) = ops.ns_splits.iter().find(|s| s.stmt_idx == info.stmt_idx) {
          existing.local_ident.clone()
        } else {
          let local_ident = fresh.numbered("__wel_l");
          ops.ns_splits.push(NsSplit {
            stmt_idx: info.stmt_idx,
            exported: info.exported.clone(),
            source: info
              .source
              .clone()
              .expect("ReExportAll always has a source"),
            local_ident: local_ident.clone(),
          });
          local_ident
        }
      }
    });
  }
  if name == "default" {
    match &index.default {
      Some(DefaultInfo::Named(local)) => return Ok(local.clone()),
      Some(DefaultInfo::Anon(stmt_idx)) => {
        if let Some((_, ident)) = &ops.default_anon {
          return Ok(ident.clone());
        }
        let ident = fresh.named("__wel_default");
        ops.default_anon = Some((*stmt_idx, ident.clone()));
        return Ok(ident);
      }
      None => {}
    }
  }
  let mut available: Vec<&str> = index
    .named
    .iter()
    .map(|info| info.exported.as_str())
    .collect();
  if index.default.is_some() {
    available.push("default");
  }
  let star_hint = if index.star_sources.is_empty() {
    String::new()
  } else {
    format!(
      "; unresolved 'export *' sources: {}",
      index.star_sources.join(", ")
    )
  };
  Err(format!(
    "export '{}' not found in module (available: {}{})",
    name,
    available.join(", "),
    star_hint
  ))
}

/// Register (or reuse) the split of an export specifier into a rebindable
/// local, keyed on the specifier's position so several entries converge on
/// one split.
fn split_local(ops: &mut RewriteOps, fresh: &mut FreshNames, info: &NamedInfo) -> String {
  if let Some(existing) = ops
    .splits
    .iter()
    .find(|s| s.stmt_idx == info.stmt_idx && s.spec_idx == info.spec_idx)
  {
    return existing.local_ident.clone();
  }
  let local_ident = fresh.numbered("__wel_l");
  ops.splits.push(Split {
    stmt_idx: info.stmt_idx,
    spec_idx: info.spec_idx,
    exported: info.exported.clone(),
    imported: info.local.clone(),
    source: info.source.clone(),
    local_ident: local_ident.clone(),
  });
  local_ident
}

/// Copy an owned name into the arena so builder calls can use it.
fn arena_ident<'a>(allocator: &'a Allocator, name: &str) -> Ident<'a> {
  Ident::from_strs_array_in([name], &allocator)
}

/// Build a `ModuleExportName` for a name that may not be a plain identifier
/// (`export { x as "not-an-ident" }` is legal).
fn module_export_name<'a>(
  allocator: &'a Allocator,
  ast: &oxc_ast::AstBuilder<'a>,
  name: &str,
) -> ModuleExportName<'a> {
  if is_plain_property_name(name) {
    ModuleExportName::IdentifierName(IdentifierName::new(SPAN, arena_ident(allocator, name), ast))
  } else {
    ModuleExportName::StringLiteral(StringLiteral::new(
      SPAN,
      arena_ident(allocator, name),
      None,
      ast,
    ))
  }
}

/// `let <name> = <init>;`
fn let_statement<'a>(
  allocator: &'a Allocator,
  ast: &oxc_ast::AstBuilder<'a>,
  name: &str,
  init: Expression<'a>,
) -> Statement<'a> {
  let kind = VariableDeclarationKind::Let;
  let pattern = BindingPattern::new_binding_identifier(SPAN, arena_ident(allocator, name), ast);
  let declarator = VariableDeclarator::new(SPAN, kind, pattern, NONE, Some(init), false, ast);
  Statement::VariableDeclaration(VariableDeclaration::boxed(
    SPAN,
    kind,
    ArenaVec::from_value_in(declarator, ast),
    false,
    ast,
  ))
}

/// `export { <local> as <exported> };`
fn export_alias_statement<'a>(
  allocator: &'a Allocator,
  ast: &oxc_ast::AstBuilder<'a>,
  local: &str,
  exported: &str,
) -> Statement<'a> {
  let specifier = ExportSpecifier::new(
    SPAN,
    module_export_name(allocator, ast, local),
    module_export_name(allocator, ast, exported),
    ImportOrExportKind::Value,
    ast,
  );
  Statement::ExportNamedDeclaration(ExportNamedDeclaration::boxed(
    SPAN,
    None,
    ArenaVec::from_value_in(specifier, ast),
    None,
    ImportOrExportKind::Value,
    NONE,
    ast,
  ))
}

/// `import { <imported> as <local> } from "<source>";`
fn import_alias_statement<'a>(
  allocator: &'a Allocator,
  ast: &oxc_ast::AstBuilder<'a>,
  imported: &str,
  local: &str,
  source: &str,
) -> Statement<'a> {
  let specifier = ImportDeclarationSpecifier::new_import_specifier(
    SPAN,
    module_export_name(allocator, ast, imported),
    BindingIdentifier::new(SPAN, arena_ident(allocator, local), ast),
    ImportOrExportKind::Value,
    ast,
  );
  Statement::ImportDeclaration(ImportDeclaration::boxed(
    SPAN,
    Some(ArenaVec::from_value_in(specifier, ast)),
    StringLiteral::new(SPAN, arena_ident(allocator, source), None, ast),
    None,
    NONE,
    ImportOrExportKind::Value,
    ast,
  ))
}

/// `import * as <local> from "<source>";`
fn import_namespace_statement<'a>(
  allocator: &'a Allocator,
  ast: &oxc_ast::AstBuilder<'a>,
  local: &str,
  source: &str,
) -> Statement<'a> {
  let specifier = ImportDeclarationSpecifier::new_import_namespace_specifier(
    SPAN,
    BindingIdentifier::new(SPAN, arena_ident(allocator, local), ast),
    ast,
  );
  Statement::ImportDeclaration(ImportDeclaration::boxed(
    SPAN,
    Some(ArenaVec::from_value_in(specifier, ast)),
    StringLiteral::new(SPAN, arena_ident(allocator, source), None, ast),
    None,
    NONE,
    ImportOrExportKind::Value,
    ast,
  ))
}

/// Apply the accumulated rewrites to the program in place:
/// - demotions flip `const` declarations to `let` where they stand;
/// - the anonymous default is replaced *at its position* by
///   `let <ident> = <expr>;` so the expression's evaluation order (and any
///   side effects) is preserved, with `export { <ident> as default };`
///   appended;
/// - split specifiers are removed from their export statement (the statement
///   itself is kept, even if emptied — `export {} from "m"` still triggers
///   the source module's load) and re-created at the end of the module as an
///   optional import alias, a `let` snapshot, and an `export { local as
///   exported };`. The snapshot evaluates at end-of-module, after every
///   declaration it can reference.
pub(crate) fn apply_rewrites<'a>(
  allocator: &'a Allocator,
  program: &mut Program<'a>,
  ops: &RewriteOps,
) -> Result<(), String> {
  use oxc_ast::AstBuilder;
  let ast = AstBuilder::new(allocator);

  for &stmt_idx in &ops.demote {
    let var = match &mut program.body[stmt_idx] {
      Statement::VariableDeclaration(var) => var,
      Statement::ExportNamedDeclaration(export) => match &mut export.declaration {
        Some(Declaration::VariableDeclaration(var)) => var,
        _ => return Err("internal: demotion target is not a variable declaration".to_string()),
      },
      _ => return Err("internal: demotion target is not a variable declaration".to_string()),
    };
    var.kind = VariableDeclarationKind::Let;
    for decl in var.declarations.iter_mut() {
      decl.kind = VariableDeclarationKind::Let;
    }
  }

  let mut appended: Vec<Statement<'a>> = Vec::new();

  if let Some((stmt_idx, ident)) = &ops.default_anon {
    let Statement::ExportDefaultDeclaration(export) = &program.body[*stmt_idx] else {
      return Err("internal: default rewrite target is not an export default".to_string());
    };
    use oxc_ast::ast::ExportDefaultDeclarationKind;
    let init: Expression<'a> = match &export.declaration {
      ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
        let mut func = func.clone_in_with_semantic_ids(allocator);
        func.id = None;
        Expression::FunctionExpression(func)
      }
      ExportDefaultDeclarationKind::ClassDeclaration(class) => {
        Expression::ClassExpression(class.clone_in_with_semantic_ids(allocator))
      }
      other => match other.as_expression() {
        Some(expr) => expr.clone_in_with_semantic_ids(allocator),
        None => {
          return Err(
            "export default of a TypeScript-only declaration is not tappable".to_string(),
          );
        }
      },
    };
    program.body[*stmt_idx] = let_statement(allocator, &ast, ident, init);
    appended.push(export_alias_statement(allocator, &ast, ident, "default"));
  }

  // group split specifier removals per statement, then rebuild each list
  let mut by_stmt: std::collections::HashMap<usize, Vec<&Split>> = std::collections::HashMap::new();
  for split in &ops.splits {
    by_stmt.entry(split.stmt_idx).or_default().push(split);
  }
  for (stmt_idx, splits) in &by_stmt {
    let Statement::ExportNamedDeclaration(export) = &mut program.body[*stmt_idx] else {
      return Err("internal: split target is not an export statement".to_string());
    };
    let removed: std::collections::HashSet<usize> = splits.iter().map(|s| s.spec_idx).collect();
    let old = std::mem::replace(&mut export.specifiers, ArenaVec::new_in(&ast));
    for (spec_idx, spec) in old.into_iter().enumerate() {
      if !removed.contains(&spec_idx) {
        export.specifiers.push(spec);
      }
    }
  }
  for split in &ops.splits {
    let source_local = match &split.source {
      Some(source) => {
        let import_local = format!("{}_src", split.local_ident);
        appended.push(import_alias_statement(
          allocator,
          &ast,
          &split.imported,
          &import_local,
          source,
        ));
        import_local
      }
      None => split.imported.clone(),
    };
    appended.push(let_statement(
      allocator,
      &ast,
      &split.local_ident,
      Expression::new_identifier(SPAN, arena_ident(allocator, &source_local), &ast),
    ));
    appended.push(export_alias_statement(
      allocator,
      &ast,
      &split.local_ident,
      &split.exported,
    ));
  }

  for ns in &ops.ns_splits {
    // the namespace import keeps the source module's load (and gives the
    // snapshot a binding); the original `export * as ns` statement is what
    // it replaces
    let import_local = format!("{}_src", ns.local_ident);
    program.body[ns.stmt_idx] =
      import_namespace_statement(allocator, &ast, &import_local, &ns.source);
    appended.push(let_statement(
      allocator,
      &ast,
      &ns.local_ident,
      Expression::new_identifier(SPAN, arena_ident(allocator, &import_local), &ast),
    ));
    appended.push(export_alias_statement(
      allocator,
      &ast,
      &ns.local_ident,
      &ns.exported,
    ));
  }

  for stmt in appended {
    program.body.push(stmt);
  }
  Ok(())
}
