use oxc_allocator::{Allocator, Box as ArenaBox, CloneIn, Vec as ArenaVec};
use oxc_ast::{
  NONE,
  ast::{
    Argument, BindingPattern, Declaration, ExportNamedDeclaration, Expression, ImportOrExportKind,
    ModuleExportName, Program, Statement, VariableDeclaration, VariableDeclarationKind,
    VariableDeclarator,
  },
};
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder, SymbolFlags};
use oxc_sourcemap::{SourceMap, SourceMapBuilder};
use oxc_span::{SPAN, SourceType};
use oxc_str::Ident;
use oxc_traverse::{Traverse, TraverseCtx, traverse_mut};

pub struct LambdaTransform<'a> {
  handler: Ident<'a>,
  orig_handler: Ident<'a>,
  wrapper: Ident<'a>,
}

impl<'a> LambdaTransform<'a> {
  pub fn new(allocator: &'a Allocator, handler: String, wrapper: String) -> Self {
    Self {
      handler: Ident::from_strs_array_in([&handler], &allocator),
      orig_handler: Ident::from_strs_array_in(["orig_", &handler], &allocator),
      wrapper: Ident::from_strs_array_in([&wrapper], &allocator),
    }
  }
  pub fn transform(
    mut self,
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    scoping: Scoping,
  ) {
    traverse_mut(&mut self, allocator, program, scoping, ());
  }
}

impl<'a> Traverse<'a, ()> for LambdaTransform<'a> {
  fn enter_program(&mut self, program: &mut Program<'a>, ctx: &mut TraverseCtx<'a, ()>) {
    self.update_handler_name(&mut program.body, ctx);

    let mut new_stmts = ctx.ast.vec_with_capacity(program.body.len() * 2);
    for stmt in program.body.drain(..) {
      match &stmt {
        Statement::ExportNamedDeclaration(export) => {
          if self.transform_export_named_declaration(&mut new_stmts, export, ctx) {
            continue;
          }
        }
        Statement::VariableDeclaration(var) => {
          let found = var
            .declarations
            .iter()
            .find(|x| x.id.get_identifier_name() == Some(self.handler));
          if let Some(found) = found {
            let init = &found.init;
            assert!(init.is_some());
            let wrapped_expr = self.wrap_expression(
              init.clone_in_with_semantic_ids(ctx.ast.allocator).unwrap(),
              ctx,
            );
            new_stmts.push(Statement::VariableDeclaration(
              ctx.ast.alloc(self.var_handler(&Some(wrapped_expr), ctx)),
            ));
            continue;
          }
        }
        _ => (),
      }
      new_stmts.push(stmt);
    }
    program.body = new_stmts;
  }
}

impl<'a> LambdaTransform<'a> {
  fn update_handler_name(
    &mut self,
    stmts: &mut ArenaVec<'a, Statement<'a>>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) {
    for stmt in stmts {
      if let Statement::ExportNamedDeclaration(export) = stmt {
        for specifier in &export.specifiers {
          if let Some(name) = specifier.exported.identifier_name()
            && name == self.handler
          {
            self.handler = Ident::from_strs_array_in([&specifier.local.name()], &ctx.ast.allocator);
            self.orig_handler =
              Ident::from_strs_array_in(["orig_", &self.handler], &ctx.ast.allocator);
            return;
          }
        }
      }
    }
  }

  fn var_handler(
    &mut self,
    init: &Option<Expression<'a>>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) -> VariableDeclaration<'a> {
    let kind = VariableDeclarationKind::Const;
    let binding = ctx.generate_binding_in_current_scope(self.handler, SymbolFlags::empty());
    let declarator = ctx.ast.variable_declarator(
      SPAN,
      kind,
      binding.create_binding_pattern(ctx),
      NONE,
      init.clone_in_with_semantic_ids(ctx.ast.allocator),
      false,
    );
    ctx
      .ast
      .variable_declaration(SPAN, kind, ctx.ast.vec1(declarator), false)
  }

  fn wrap_expression(
    &mut self,
    expr: Expression<'a>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) -> Expression<'a> {
    ctx.ast.expression_call(
      SPAN,
      ctx.ast.expression_identifier(SPAN, self.wrapper),
      NONE,
      ctx.ast.vec1(Argument::from(
        expr.clone_in_with_semantic_ids(ctx.ast.allocator),
      )),
      false,
    )
  }

  fn replace_var_declarator_at(
    &mut self,
    declarations: &mut ArenaVec<'a, VariableDeclarator<'a>>,
    index: usize,
    new_decl: VariableDeclarator<'a>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) {
    if index < declarations.len() {
      declarations[index] = new_decl.clone_in_with_semantic_ids(ctx.ast.allocator);
    } else {
      declarations.push(new_decl);
    }
  }

  fn transform_export_named_declaration(
    &mut self,
    new_stmts: &mut ArenaVec<'a, Statement<'a>>,
    export: &ArenaBox<'a, ExportNamedDeclaration<'a>>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) -> bool {
    let export = export.as_ref();
    if let Some(declaration) = &export.declaration {
      match &declaration {
        Declaration::VariableDeclaration(var) => {
          for (index, decl) in var.declarations.iter().enumerate() {
            match &decl.id {
              BindingPattern::BindingIdentifier(identifier) => {
                if identifier.name == self.handler {
                  let mut new_declarations = var
                    .declarations
                    .clone_in_with_semantic_ids(ctx.ast.allocator);
                  let expr = self.wrap_expression(
                    decl
                      .init
                      .clone_in_with_semantic_ids(ctx.ast.allocator)
                      .unwrap(),
                    ctx,
                  );
                  self.replace_var_declarator_at(
                    &mut new_declarations,
                    index,
                    ctx.ast.variable_declarator(
                      SPAN,
                      var.kind,
                      ctx
                        .generate_binding_in_current_scope(self.handler, SymbolFlags::empty())
                        .create_binding_pattern(ctx),
                      NONE,
                      Some(expr),
                      false,
                    ),
                    ctx,
                  );
                  new_stmts.push(Statement::ExportNamedDeclaration(
                    ctx.ast.alloc_export_named_declaration(
                      SPAN,
                      Some(Declaration::VariableDeclaration(
                        ctx
                          .ast
                          .alloc_variable_declaration(SPAN, var.kind, new_declarations, false),
                      )),
                      ctx.ast.vec(),
                      None,
                      ImportOrExportKind::Value,
                      NONE,
                    ),
                  ));
                  return true;
                }
              }
              BindingPattern::ObjectPattern(pattern) => {
                for prop in &pattern.properties {
                  if let Some(name) = prop.key.name()
                    && name == self.handler
                  {
                    let init = &decl.init;
                    assert!(init.is_some());
                    // todo: wrap init with object pattern specific code
                    // e.g: (p => { return { ...p, handler: wrapper(p.handler) }; })(obj)
                    return false;
                  }
                }
              }
              _ => {
                // Other patterns are not supported
                continue;
              }
            }
          }
        }
        Declaration::FunctionDeclaration(func)
          if func.name().is_some_and(|x| x == self.handler) =>
        {
          let mut func = func.clone_in_with_semantic_ids(ctx.ast.allocator);
          func.id = None;
          let init = self.wrap_expression(Expression::FunctionExpression(func), ctx);
          let var_decl = self.var_handler(&Some(init), ctx);
          new_stmts.push(Statement::ExportNamedDeclaration(
            ctx.ast.alloc_export_named_declaration(
              SPAN,
              Some(Declaration::VariableDeclaration(ctx.ast.alloc(var_decl))),
              ctx.ast.vec(),
              None,
              ImportOrExportKind::Value,
              NONE,
            ),
          ));
          return true;
        }
        _ => (),
      };
    } else if export.source.is_some() {
      for specifier in &export.specifiers {
        if let Some(name) = specifier.exported.identifier_name()
          && name == self.handler
        {
          new_stmts.push(Statement::ImportDeclaration(
            ctx.ast.alloc_import_declaration(
              SPAN,
              Some(
                ctx
                  .ast
                  .vec1(ctx.ast.import_declaration_specifier_import_specifier(
                    SPAN,
                    ModuleExportName::IdentifierName(ctx.ast.identifier_name(SPAN, self.handler)),
                    ctx.ast.binding_identifier(SPAN, self.orig_handler),
                    ImportOrExportKind::Value,
                  )),
              ),
              export
                .source
                .clone_in_with_semantic_ids(ctx.ast.allocator)
                .unwrap(),
              None,
              NONE,
              ImportOrExportKind::Value,
            ),
          ));
          let init =
            self.wrap_expression(ctx.ast.expression_identifier(SPAN, self.orig_handler), ctx);
          let var_decl = self.var_handler(&Some(init), ctx);
          new_stmts.push(Statement::ExportNamedDeclaration(
            ctx.ast.alloc_export_named_declaration(
              SPAN,
              Some(Declaration::VariableDeclaration(ctx.ast.alloc(var_decl))),
              ctx.ast.vec(),
              None,
              ImportOrExportKind::Value,
              NONE,
            ),
          ));
          return true;
        }
      }
    }
    false
  }
}

/// A generated source map in both the forms callers need: `json` (a v3 map, for
/// composing with an upstream `.ts` -> `.js` map on the JS side) and `data_url`
/// (for embedding inline).
pub struct MapOutput {
  pub json: String,
  pub data_url: String,
}

/// Compose `wrap_map` (`transformed -> intermediate`, fresh from codegen) with
/// `upstream` (`intermediate -> original`, e.g. tsc's `handler.js ->
/// handler.ts` map): every wrap token's source position is traced through
/// `upstream`, so the result maps the transformed code straight to the
/// original. This is the same trace `@ampproject/remapping` performs in JS,
/// done here with `oxc_sourcemap` token lookup instead — and since the wrap
/// map never leaves Rust, it also skips a JSON serialize/re-parse round-trip.
/// Tokens `upstream` has no mapping for are dropped, matching `remapping`.
fn chain_source_maps<'a>(wrap_map: &'a SourceMap, upstream: &'a SourceMap) -> SourceMap<'a> {
  let lookup_table = upstream.generate_lookup_table();
  let mut builder = SourceMapBuilder::default();
  if let Some(file) = wrap_map.get_file() {
    builder.set_file(file);
  }
  for token in wrap_map.get_tokens() {
    let original = upstream.lookup_source_view_token_approx(
      &lookup_table,
      token.get_src_line(),
      token.get_src_col(),
    );
    let Some(original) = original else { continue };
    let Some(source) = original.get_source() else {
      continue;
    };
    let src_id =
      builder.add_source_and_content(source, original.get_source_content().unwrap_or(""));
    let name = original
      .get_name()
      .or_else(|| token.get_name_id().and_then(|id| wrap_map.get_name(id)));
    let name_id = name.map(|name| builder.add_name(name));
    builder.add_token(
      token.get_dst_line(),
      token.get_dst_col(),
      original.get_src_line(),
      original.get_src_col(),
      Some(src_id),
      name_id,
    );
  }
  builder.into_sourcemap()
}

/// Parse `source_text`, wrap the handler, and generate code. When
/// `source_map_path` is `Some`, oxc also emits a source map (relative to that
/// path). When `None`, no map is generated (the fast path used by callers that
/// only need the transformed code).
///
/// When `upstream_map_json` is also given, the emitted map is chained through
/// it via [`chain_source_maps`] before serialization, so the returned
/// [`MapOutput`] already reaches the upstream map's original sources.
fn transform_and_generate(
  source_text: &str,
  handler: String,
  wrapper: String,
  source_map_path: Option<std::path::PathBuf>,
  upstream_map_json: Option<&str>,
) -> (String, Option<MapOutput>) {
  let allocator = Allocator::default();
  let parsed = Parser::new(&allocator, source_text, SourceType::mjs()).parse();
  let mut program = parsed.program;
  let scoping = SemanticBuilder::new()
    .build(&program)
    .semantic
    .into_scoping();
  LambdaTransform::new(&allocator, handler, wrapper).transform(&allocator, &mut program, scoping);
  let ret = Codegen::new()
    .with_options(CodegenOptions {
      source_map_path,
      ..CodegenOptions::default()
    })
    .build(&program);
  let map = ret.map.as_ref().map(|wrap_map| {
    let upstream = upstream_map_json
      .map(|json| SourceMap::from_json_string(json).expect("invalid upstream source map JSON"));
    let chained = upstream
      .as_ref()
      .map(|upstream| chain_source_maps(wrap_map, upstream));
    let map = chained.as_ref().unwrap_or(wrap_map);
    MapOutput {
      json: map.to_json_string(),
      data_url: map.to_data_url(),
    }
  });
  (ret.code, map)
}

pub fn transform_lambda_source(source_text: &str, handler: String, wrapper: String) -> String {
  transform_and_generate(source_text, handler, wrapper, None, None).0
}

/// Same as [`transform_lambda_source`], but appends an inline
/// `//# sourceMappingURL=` data-URL source map that maps the generated code
/// back to `filename`. The wrapped handler body keeps its original spans, so an
/// exception thrown inside the handler resolves to the original source line
/// under Node's `--enable-source-maps`.
pub fn transform_lambda_source_with_map(
  source_text: String,
  handler: String,
  wrapper: String,
  filename: String,
) -> String {
  let (mut code, map) = transform_and_generate(
    &source_text,
    handler,
    wrapper,
    Some(std::path::PathBuf::from(filename)),
    None,
  );
  if let Some(map) = map {
    code.push_str("\n//# sourceMappingURL=");
    code.push_str(&map.data_url);
    code.push('\n');
  }
  code
}

/// Like [`transform_lambda_source_with_map`], but returns the code and the raw
/// v3 source map JSON separately (no inline URL appended). The JSON is what a
/// caller composes with an upstream `.ts` -> `.js` map so the final map reaches
/// the original TypeScript.
pub fn transform_lambda_source_with_map_json(
  source_text: String,
  handler: String,
  wrapper: String,
  filename: String,
) -> (String, Option<String>) {
  let (code, map) = transform_and_generate(
    &source_text,
    handler,
    wrapper,
    Some(std::path::PathBuf::from(filename)),
    None,
  );
  (code, map.map(|map| map.json))
}

/// Same as [`transform_lambda_source_with_map`], but chains the wrap map
/// through `upstream_map_json` (`filename -> original`, e.g. tsc's
/// `handler.js -> handler.ts` map) in Rust before inlining it, so the appended
/// data URL already reaches the original source. The compose that
/// `@ampproject/remapping` would do in JS happens here via `oxc_sourcemap`.
///
/// Panics if `upstream_map_json` is not a valid v3 source map (surfaces as a
/// JS exception through napi, like `remapping` throwing on bad input).
pub fn transform_lambda_source_with_chained_map(
  source_text: String,
  handler: String,
  wrapper: String,
  filename: String,
  upstream_map_json: String,
) -> String {
  let (mut code, map) = transform_and_generate(
    &source_text,
    handler,
    wrapper,
    Some(std::path::PathBuf::from(filename)),
    Some(&upstream_map_json),
  );
  if let Some(map) = map {
    code.push_str("\n//# sourceMappingURL=");
    code.push_str(&map.data_url);
    code.push('\n');
  }
  code
}

/// Like [`transform_lambda_source_with_chained_map`], but returns the code and
/// the chained v3 map JSON separately (no inline URL appended).
pub fn transform_lambda_source_with_chained_map_json(
  source_text: String,
  handler: String,
  wrapper: String,
  filename: String,
  upstream_map_json: String,
) -> (String, Option<String>) {
  let (code, map) = transform_and_generate(
    &source_text,
    handler,
    wrapper,
    Some(std::path::PathBuf::from(filename)),
    Some(&upstream_map_json),
  );
  (code, map.map(|map| map.json))
}

/// One patch entry's inputs to the exports tap, mirroring the JS config
/// entry. `alias_index` keeps the injected import alias unique when several
/// entries patch the same module in import delivery.
pub struct TapEntry {
  pub bindings: Vec<String>,
  pub patch_name: String,
  pub patch_from: String,
  pub alias_index: u32,
}

/// What the tap asks the caller to do to one module, for all its patch
/// entries at once:
/// - `code = None` (the fast path): every requested binding was already a
///   reassignable local — the module source is untouched, only `snippets`
///   gets appended, so existing source maps and the zero-copy byte path
///   stay intact.
/// - `code = Some(...)` (the rewrite path): some binding needed
///   restructuring (a `const` export, an anonymous default, a re-export, an
///   import-backed local). The module was re-generated from its AST with the
///   restructuring applied; `map` carries the v3 source map of that rewrite,
///   already chained through `upstream_map` when one was given. `snippets`
///   is appended after the rewritten code.
#[derive(Debug)]
pub struct TapOutput {
  pub snippets: String,
  pub code: Option<String>,
  pub map: Option<String>,
}

/// Minimal JS string literal escaping for generated specifiers.
fn quote_js_string(value: &str) -> String {
  let mut out = String::with_capacity(value.len() + 2);
  out.push('"');
  for ch in value.chars() {
    match ch {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      _ => out.push(ch),
    }
  }
  out.push('"');
  out
}

/// How a named export reaches its value, as far as static analysis sees.
enum NamedKind {
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

struct NamedInfo {
  exported: String,
  local: String,
  kind: NamedKind,
  stmt_idx: usize,
  spec_idx: usize,
  /// the module specifier for `ReExport` entries, `None` otherwise
  source: Option<String>,
}

enum DefaultInfo {
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
struct ExportIndex {
  named: Vec<NamedInfo>,
  default: Option<DefaultInfo>,
  import_locals: std::collections::HashSet<String>,
  /// top-level `const` declarations (exported directly or not) by name →
  /// statement index, for demotion of list-exported consts
  top_const: std::collections::HashMap<String, usize>,
  /// specifiers of bare `export * from "m"` statements — names these forward
  /// are not statically visible from this module alone; the caller may walk
  /// them (see `esm_module_exports`) and retry with star resolutions
  star_sources: Vec<String>,
}

fn build_export_index(program: &Program) -> ExportIndex {
  let mut index = ExportIndex {
    named: Vec::new(),
    default: None,
    import_locals: std::collections::HashSet::new(),
    top_const: std::collections::HashMap::new(),
    star_sources: Vec::new(),
  };
  for (stmt_idx, stmt) in program.body.iter().enumerate() {
    match stmt {
      Statement::ImportDeclaration(import) => {
        if let Some(specifiers) = &import.specifiers {
          for spec in specifiers {
            index.import_locals.insert(spec.local().name.to_string());
          }
        }
      }
      Statement::VariableDeclaration(var) => {
        if var.kind == VariableDeclarationKind::Const {
          let mut names = Vec::new();
          for decl in &var.declarations {
            collect_bound_names(&decl.id, &mut names);
          }
          for name in names {
            index.top_const.insert(name, stmt_idx);
          }
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

/// The restructurings the resolver accumulated: applied in one pass, then the
/// module is re-generated through oxc codegen (with a source map). All ops
/// are deduplicated — several entries tapping the same binding converge on
/// identical rewrites.
#[derive(Default)]
struct RewriteOps {
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
  fn is_empty(&self) -> bool {
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
struct FreshNames<'s> {
  source: &'s str,
  counter: u32,
}

impl<'s> FreshNames<'s> {
  fn new(source: &'s str) -> Self {
    Self { source, counter: 0 }
  }
  /// Numbered from zero: `__wel_l0`, `__wel_l1`, ... — for the split locals.
  fn numbered(&mut self, prefix: &str) -> String {
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
fn resolve_binding(
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
        if index.import_locals.contains(&info.local) {
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

/// True when `name` can appear bare as an object-literal property name.
fn is_plain_property_name(name: &str) -> bool {
  !name.is_empty()
    && !name.chars().next().unwrap().is_ascii_digit()
    && name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Append the get/set accessor properties for the tapped bindings. `local` is
/// how the module reaches the value (a local identifier for ESM, a
/// `module.exports.X` path for CJS); a missing setter makes assignment throw
/// loudly in strict mode. Names that are not plain identifiers (the reserved
/// `"module.exports"` binding) are emitted as quoted property names.
///
/// `verify_set` (the CJS property accessors) guards the one silent failure
/// mode assignment has: bundled CJS (esbuild/tsup output) defines exports as
/// non-configurable getters and is NOT strict mode, so `module.exports.X = v`
/// on it is a silent no-op — the setter re-reads the property and throws if
/// the rebind did not take.
fn push_accessors(out: &mut String, bindings: &[(String, String, bool, bool)]) {
  for (exported, local, reassignable, verify_set) in bindings {
    let quoted;
    let name: &str = if is_plain_property_name(exported) {
      exported
    } else {
      quoted = quote_js_string(exported);
      &quoted
    };
    out.push_str("\n  get ");
    out.push_str(name);
    out.push_str("() { return ");
    out.push_str(local);
    out.push_str("; },");
    if *reassignable {
      out.push_str("\n  set ");
      out.push_str(name);
      out.push_str("(v) { ");
      out.push_str(local);
      out.push_str(" = v;");
      if *verify_set {
        out.push_str(" if (");
        out.push_str(local);
        out.push_str(" !== v) throw new TypeError(\"wrap-esm-lambda: rebinding ");
        out.push_str(exported);
        out.push_str(" had no effect (getter-only CJS export)\");");
      }
      out.push_str(" },");
    }
  }
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
    ModuleExportName::IdentifierName(ast.identifier_name(SPAN, arena_ident(allocator, name)))
  } else {
    ModuleExportName::StringLiteral(ast.string_literal(SPAN, arena_ident(allocator, name), None))
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
  let pattern = ast.binding_pattern_binding_identifier(SPAN, arena_ident(allocator, name));
  let declarator = ast.variable_declarator(SPAN, kind, pattern, NONE, Some(init), false);
  Statement::VariableDeclaration(ast.alloc_variable_declaration(
    SPAN,
    kind,
    ast.vec1(declarator),
    false,
  ))
}

/// `export { <local> as <exported> };`
fn export_alias_statement<'a>(
  allocator: &'a Allocator,
  ast: &oxc_ast::AstBuilder<'a>,
  local: &str,
  exported: &str,
) -> Statement<'a> {
  let specifier = ast.export_specifier(
    SPAN,
    module_export_name(allocator, ast, local),
    module_export_name(allocator, ast, exported),
    ImportOrExportKind::Value,
  );
  Statement::ExportNamedDeclaration(ast.alloc_export_named_declaration(
    SPAN,
    None,
    ast.vec1(specifier),
    None,
    ImportOrExportKind::Value,
    NONE,
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
  Statement::ImportDeclaration(ast.alloc_import_declaration(
    SPAN,
    Some(ast.vec1(ast.import_declaration_specifier_import_specifier(
      SPAN,
      module_export_name(allocator, ast, imported),
      ast.binding_identifier(SPAN, arena_ident(allocator, local)),
      ImportOrExportKind::Value,
    ))),
    ast.string_literal(SPAN, arena_ident(allocator, source), None),
    None,
    NONE,
    ImportOrExportKind::Value,
  ))
}

/// `import * as <local> from "<source>";`
fn import_namespace_statement<'a>(
  allocator: &'a Allocator,
  ast: &oxc_ast::AstBuilder<'a>,
  local: &str,
  source: &str,
) -> Statement<'a> {
  Statement::ImportDeclaration(ast.alloc_import_declaration(
    SPAN,
    Some(
      ast.vec1(ast.import_declaration_specifier_import_namespace_specifier(
        SPAN,
        ast.binding_identifier(SPAN, arena_ident(allocator, local)),
      )),
    ),
    ast.string_literal(SPAN, arena_ident(allocator, source), None),
    None,
    NONE,
    ImportOrExportKind::Value,
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
fn apply_rewrites<'a>(
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
    let old = std::mem::replace(&mut export.specifiers, ast.vec());
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
      ast.expression_identifier(SPAN, arena_ident(allocator, &source_local)),
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
      ast.expression_identifier(SPAN, arena_ident(allocator, &import_local)),
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

/// A caller-provided resolution for a name forwarded by a bare
/// `export * from`: the requested `binding` is (transitively) provided by
/// the star source `source`. The caller learns this by walking the star
/// graph with `esm_module_exports` over the source files — something only
/// it can do, since it owns module resolution and file access.
pub struct StarResolution {
  pub binding: String,
  pub source: String,
}

/// A name in `import { <name> as x }` / `export { x as <name> }` braces:
/// plain identifiers stay bare, anything else becomes a string literal
/// (`import { "a-b" as x }` is legal ESM).
fn brace_name(name: &str) -> String {
  if is_plain_property_name(name) {
    name.to_string()
  } else {
    quote_js_string(name)
  }
}

/// Append-only redirect for a star-forwarded name, exploiting that an
/// explicit named export shadows a bare `export *` for the same name: the
/// star statement stays untouched, and these three appended statements
/// (imports and exports hoist) reroute `name` through a rebindable local.
/// No rewrite, no codegen — the source and its maps stay intact.
fn push_star_stub(stubs: &mut String, name: &str, source: &str, local: &str) {
  stubs.push_str(
    "
import { ",
  );
  stubs.push_str(&brace_name(name));
  stubs.push_str(" as ");
  stubs.push_str(local);
  stubs.push_str("_src } from ");
  stubs.push_str(&quote_js_string(source));
  stubs.push_str(
    ";
let ",
  );
  stubs.push_str(local);
  stubs.push_str(" = ");
  stubs.push_str(local);
  stubs.push_str(
    "_src;
export { ",
  );
  stubs.push_str(local);
  stubs.push_str(" as ");
  stubs.push_str(&brace_name(name));
  stubs.push_str(
    " };
",
  );
}

/// Per-entry accessor snippet (the patch call), shared by both paths.
fn build_snippet(
  accessors: &[(String, String, bool, bool)],
  patch_name: &str,
  patch_from: &str,
  registry: bool,
  alias_index: u32,
) -> String {
  let mut out = String::with_capacity(512);
  if registry {
    let key = format!("{}#{}", patch_from, patch_name);
    out.push_str("\n;(() => {\nconst __wel_registry = globalThis[Symbol.for(\"wrap-esm-lambda.patches\")];\nconst __wel_patch = __wel_registry && __wel_registry[");
    out.push_str(&quote_js_string(&key));
    out.push_str("];\nif (__wel_patch) __wel_patch({");
    push_accessors(&mut out, accessors);
    out.push_str("\n});\n})();\n");
  } else {
    let alias = format!("__wel_patch_{}", alias_index);
    out.push_str("\nimport { ");
    out.push_str(patch_name);
    out.push_str(" as ");
    out.push_str(&alias);
    out.push_str(" } from ");
    out.push_str(&quote_js_string(patch_from));
    out.push_str(";\n");
    out.push_str(&alias);
    out.push_str("({");
    push_accessors(&mut out, accessors);
    out.push_str("\n});\n");
  }
  out
}

/// The generic "exports tap", for every patch entry of one module at once:
/// hand each entry's patch function the module's live bindings as get/set
/// accessors, appended as a snippet after the module source.
///
/// The module is parsed once and each requested name resolved against its
/// statically visible exports (a missing export is a hard error — the
/// version-drift alarm). Two outcomes:
///
/// - **Fast path** (`code: None`): every requested binding is already a
///   reassignable module-local (`let`/`var`/function/class declarations,
///   list exports of mutable locals, named default declarations). Nothing
///   but the snippet is emitted — the source is untouched, existing source
///   maps stay valid, and a byte-buffer caller never converts the source.
///
/// - **Rewrite path** (`code: Some`): a requested binding needs
///   restructuring to become rebindable — `export const` (demoted to
///   `let`), an anonymous `export default` (named into a local), a
///   re-export or import-backed list export (split into an import plus a
///   rebindable `let` snapshot; such a snapshot no longer tracks later
///   live-binding updates of the source module, which is the documented
///   cost of tapping those shapes). The whole module is regenerated through
///   oxc codegen with a source map (chained through `upstream_map_json`
///   when the caller already transformed this module).
///
/// CJS (`cjs = true`): accessors go through `module.exports` (which also
/// works with the getter-only exports esbuild-bundled packages define, via
/// verified setters), no static validation is possible, and no rewrite is
/// ever needed — `source_text` is ignored; pass an empty string.
///
/// Delivery per entry: `registry = false` (build time) emits a static
/// import of `patch_from` aliased by `alias_index`; `registry = true`
/// (runtime) looks the patch up in the
/// `globalThis[Symbol.for("wrap-esm-lambda.patches")]` registry the runtime
/// shell preloads — no injected import/require at all.
pub fn exports_tap(
  source_text: &str,
  entries: &[TapEntry],
  cjs: bool,
  registry: bool,
  filename: Option<&str>,
  upstream_map_json: Option<&str>,
  star_resolutions: &[StarResolution],
) -> Result<TapOutput, String> {
  if cjs {
    let mut snippets = String::new();
    for entry in entries {
      let accessors: Vec<(String, String, bool, bool)> = entry
        .bindings
        .iter()
        .map(|name| {
          // Reserved binding: the whole `module.exports` — for CJS packages
          // whose exports object IS the API (express, fastify), where
          // wrapping the callable means rebinding module.exports itself.
          // The name can never collide with a real property (it is not an
          // identifier). Assigning the `module.exports` slot always works
          // (plain writable property), so no set verification there.
          if name == "module.exports" {
            (name.clone(), "module.exports".to_string(), true, false)
          } else {
            (name.clone(), format!("module.exports.{}", name), true, true)
          }
        })
        .collect();
      snippets.push_str(&build_snippet(
        &accessors,
        &entry.patch_name,
        &entry.patch_from,
        registry,
        entry.alias_index,
      ));
    }
    return Ok(TapOutput {
      snippets,
      code: None,
      map: None,
    });
  }

  let allocator = Allocator::default();
  let parsed = Parser::new(&allocator, source_text, SourceType::mjs()).parse();
  let mut program = parsed.program;
  let index = build_export_index(&program);
  let mut ops = RewriteOps::default();
  let mut fresh = FreshNames::new(source_text);

  let star_map: std::collections::HashMap<&str, &str> = star_resolutions
    .iter()
    .map(|resolution| (resolution.binding.as_str(), resolution.source.as_str()))
    .collect();
  let mut star_locals: std::collections::HashMap<String, String> = std::collections::HashMap::new();
  let mut star_stubs = String::new();

  // resolve every entry first: validation errors must fire before any
  // rewrite decision, and entries tapping the same binding share rewrites
  let mut entry_accessors: Vec<Vec<(String, String, bool, bool)>> =
    Vec::with_capacity(entries.len());
  for entry in entries {
    let mut accessors = Vec::with_capacity(entry.bindings.len());
    for name in &entry.bindings {
      let local = match resolve_binding(name, &index, &mut ops, &mut fresh) {
        Ok(local) => local,
        // a name the module's own exports don't have, but the caller's
        // star-graph walk located in one of the `export * from` sources:
        // reroute it through an append-only shadow export
        Err(err) => match star_map.get(name.as_str()) {
          Some(source) => {
            if let Some(existing) = star_locals.get(name) {
              existing.clone()
            } else {
              let local = fresh.numbered("__wel_l");
              push_star_stub(&mut star_stubs, name, source, &local);
              star_locals.insert(name.clone(), local.clone());
              local
            }
          }
          None => return Err(err),
        },
      };
      // ESM locals are strict-mode bindings; after resolution every local
      // is reassignable, so no set verification is needed.
      accessors.push((name.clone(), local, true, false));
    }
    entry_accessors.push(accessors);
  }

  let mut snippets = star_stubs;
  for (entry, accessors) in entries.iter().zip(&entry_accessors) {
    snippets.push_str(&build_snippet(
      accessors,
      &entry.patch_name,
      &entry.patch_from,
      registry,
      entry.alias_index,
    ));
  }

  if ops.is_empty() {
    return Ok(TapOutput {
      snippets,
      code: None,
      map: None,
    });
  }

  apply_rewrites(&allocator, &mut program, &ops)?;
  let ret = Codegen::new()
    .with_options(CodegenOptions {
      source_map_path: filename.map(std::path::PathBuf::from),
      ..CodegenOptions::default()
    })
    .build(&program);
  let map = ret.map.as_ref().map(|tap_map| {
    let upstream = upstream_map_json
      .map(|json| SourceMap::from_json_string(json).expect("invalid upstream source map JSON"));
    let chained = upstream
      .as_ref()
      .map(|upstream| chain_source_maps(tap_map, upstream));
    chained.as_ref().unwrap_or(tap_map).to_json_string()
  });
  Ok(TapOutput {
    snippets,
    code: Some(ret.code),
    map,
  })
}

/// The statically visible surface of an ESM module, for the caller's
/// star-graph walk: every exported name (including `default` and
/// `export * as ns` names) plus the specifiers of bare `export * from`
/// statements, whose forwarded names require reading those sources.
pub fn esm_module_exports(source_text: &str) -> (Vec<String>, Vec<String>) {
  let allocator = Allocator::default();
  let parsed = Parser::new(&allocator, source_text, SourceType::mjs()).parse();
  let index = build_export_index(&parsed.program);
  let mut names: Vec<String> = index
    .named
    .iter()
    .map(|info| info.exported.clone())
    .collect();
  if index.default.is_some() {
    names.push("default".to_string());
  }
  (names, index.star_sources)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_chained_source_map() {
    // Simulate the tsc pipeline without tsc: `original` plays handler.ts.
    // Codegen strips its blank lines, producing an intermediate handler.js
    // plus an upstream map (handler.js -> handler.ts), exactly the two inputs
    // the wrap step sees at load time. The chained wrap map must then reach
    // handler.ts, not stop at handler.js.
    let original =
      "export const handler = async (event) => {\n\n\n  throw new Error(\"boom\");\n};\n";
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, original, SourceType::mjs()).parse();
    let ret = Codegen::new()
      .with_options(CodegenOptions {
        source_map_path: Some(std::path::PathBuf::from("handler.ts")),
        ..CodegenOptions::default()
      })
      .build(&parsed.program);
    let upstream_json = ret.map.unwrap().to_json_string();

    let (code, map) = transform_lambda_source_with_chained_map_json(
      ret.code,
      "handler".to_string(),
      "wrapper".to_string(),
      "handler.js".to_string(),
      upstream_json,
    );
    println!("{}", code);
    assert!(code.contains("wrapper("));
    let map = map.expect("chained map should be generated");
    println!("{}", map);
    assert!(map.contains("\"sources\":[\"handler.ts\"]"));
    // The upstream map embeds `original` as sourcesContent; chaining carries it over.
    assert!(map.contains("\"sourcesContent\""));
  }

  fn tap1(source: &str, bindings: &[&str], cjs: bool, registry: bool) -> Result<TapOutput, String> {
    exports_tap(
      source,
      &[TapEntry {
        bindings: bindings.iter().map(|b| b.to_string()).collect(),
        patch_name: "patchIt".to_string(),
        patch_from: "/abs/patch.ts".to_string(),
        alias_index: 0,
      }],
      cjs,
      registry,
      Some("mod.js"),
      None,
      &[],
    )
  }

  #[test]
  fn test_exports_tap_fast_path_mutable_bindings() {
    let source = "export class Client {\n\tsend(command) {\n\t\treturn command;\n\t}\n}\n";
    let out = tap1(source, &["Client"], false, false).unwrap();
    println!("{}", out.snippets);
    assert!(
      out.code.is_none(),
      "mutable bindings must stay on the append-only fast path"
    );
    assert!(out.map.is_none());
    assert!(
      out
        .snippets
        .contains("import { patchIt as __wel_patch_0 } from \"/abs/patch.ts\";")
    );
    assert!(out.snippets.contains("get Client() { return Client; }"));
    assert!(out.snippets.contains("set Client(v) { Client = v; }"));
  }

  #[test]
  fn test_exports_tap_registry_delivery() {
    let source = "export class Client {}\n";
    let out = tap1(source, &["Client"], false, true).unwrap();
    assert!(out.snippets.starts_with("\n"), "snippet is append-ready");
    assert!(
      !out.snippets.contains("import {"),
      "registry delivery injects no import"
    );
    assert!(
      out
        .snippets
        .contains("globalThis[Symbol.for(\"wrap-esm-lambda.patches\")]")
    );
    assert!(out.snippets.contains("[\"/abs/patch.ts#patchIt\"]"));
  }

  #[test]
  fn test_exports_tap_const_demoted_to_let() {
    let source = "export const handler = async (event) => event;\n";
    let out = tap1(source, &["handler"], false, true).unwrap();
    let code = out.code.expect("const export must take the rewrite path");
    println!("{}\n{}", code, out.snippets);
    assert!(
      code.contains("export let handler"),
      "const is demoted to let"
    );
    assert!(out.map.is_some(), "rewrite emits a source map");
    assert!(
      out.snippets.contains("set handler(v) { handler = v; }"),
      "demoted const gets a setter"
    );
  }

  #[test]
  fn test_exports_tap_list_exported_const_demoted() {
    let source = "const y = async (e) => e;\nexport { y as handler };\n";
    let out = tap1(source, &["handler"], false, true).unwrap();
    let code = out
      .code
      .expect("list-exported const must take the rewrite path");
    println!("{}", code);
    assert!(
      code.contains("let y"),
      "the local const behind the list export is demoted"
    );
    assert!(code.contains("export { y as handler }"));
    assert!(out.snippets.contains("set handler(v) { y = v; }"));
  }

  #[test]
  fn test_exports_tap_default_named_class_is_fast_path() {
    let source = "export default class Hono {\n\troute(p) { return p; }\n}\n";
    let out = tap1(source, &["default"], false, true).unwrap();
    assert!(
      out.code.is_none(),
      "named default declarations are live aliases — append suffices"
    );
    assert!(out.snippets.contains("get default() { return Hono; }"));
    assert!(out.snippets.contains("set default(v) { Hono = v; }"));
  }

  #[test]
  fn test_exports_tap_default_anonymous_is_named() {
    let source = "export default async (event) => event;\n";
    let out = tap1(source, &["default"], false, true).unwrap();
    let code = out
      .code
      .expect("anonymous default must take the rewrite path");
    println!("{}\n{}", code, out.snippets);
    assert!(code.contains("let __wel_default = async (event) => event;"));
    assert!(code.contains("export { __wel_default as default }"));
    assert!(
      out
        .snippets
        .contains("set default(v) { __wel_default = v; }")
    );
  }

  #[test]
  fn test_exports_tap_reexport_split() {
    let source = "export { Client, VERSION } from \"./client.js\";\n";
    let out = tap1(source, &["Client"], false, true).unwrap();
    let code = out.code.expect("re-export must take the rewrite path");
    println!("{}", code);
    assert!(
      code.contains("export { VERSION } from \"./client.js\";"),
      "untapped specifiers stay"
    );
    assert!(code.contains("import { Client as __wel_l0_src } from \"./client.js\";"));
    assert!(code.contains("let __wel_l0 = __wel_l0_src;"));
    assert!(code.contains("export { __wel_l0 as Client }"));
    assert!(out.snippets.contains("set Client(v) { __wel_l0 = v; }"));
  }

  #[test]
  fn test_exports_tap_import_backed_local_split() {
    let source = "import { x } from \"./dep.js\";\nexport { x };\n";
    let out = tap1(source, &["x"], false, true).unwrap();
    let code = out
      .code
      .expect("import-backed local must take the rewrite path");
    println!("{}", code);
    assert!(code.contains("let __wel_l0 = x;"));
    assert!(code.contains("export { __wel_l0 as x }"));
  }

  #[test]
  fn test_exports_tap_destructured_const_export() {
    let source = "export const { greet, meta: [info] } = make();\n";
    let out = tap1(source, &["greet", "info"], false, true).unwrap();
    let code = out
      .code
      .expect("destructured const must take the rewrite path");
    println!("{}\n{}", code, out.snippets);
    assert!(
      code.contains("export let {"),
      "the whole pattern declaration is demoted"
    );
    assert!(out.snippets.contains("set greet(v) { greet = v; }"));
    assert!(out.snippets.contains("set info(v) { info = v; }"));
  }

  #[test]
  fn test_exports_tap_destructured_let_export_is_fast_path() {
    let source = "export let { greet } = make();\n";
    let out = tap1(source, &["greet"], false, true).unwrap();
    assert!(
      out.code.is_none(),
      "let destructuring is already reassignable — append only"
    );
    assert!(out.snippets.contains("set greet(v) { greet = v; }"));
  }

  #[test]
  fn test_exports_tap_top_level_const_pattern_behind_list_export() {
    let source = "const { a } = make();\nexport { a as alpha };\n";
    let out = tap1(source, &["alpha"], false, true).unwrap();
    let code = out
      .code
      .expect("the const pattern behind the list export must be demoted");
    println!("{}", code);
    assert!(code.contains("let {"), "top-level const pattern demoted");
    assert!(out.snippets.contains("set alpha(v) { a = v; }"));
  }

  #[test]
  fn test_exports_tap_namespace_reexport() {
    let source = "export * as ns from \"./m.js\";\n";
    let out = tap1(source, &["ns"], false, true).unwrap();
    let code = out.code.expect("export * as ns must take the rewrite path");
    println!("{}\n{}", code, out.snippets);
    assert!(code.contains("import * as __wel_l0_src from \"./m.js\";"));
    assert!(code.contains("let __wel_l0 = __wel_l0_src;"));
    assert!(code.contains("export { __wel_l0 as ns }"));
    assert!(out.snippets.contains("set ns(v) { __wel_l0 = v; }"));
  }

  #[test]
  fn test_exports_tap_bare_export_star_unresolved_is_loud_with_hint() {
    let source = "export * from \"./m.js\";\nexport class Client {}\n";
    let err = tap1(source, &["Hidden"], false, true).unwrap_err();
    assert!(
      err.contains("export 'Hidden' not found"),
      "bare star names are not static: {err}"
    );
    assert!(
      err.contains("unresolved 'export *' sources: ./m.js"),
      "error names the stars: {err}"
    );
  }

  #[test]
  fn test_exports_tap_star_resolution_appends_shadow_export() {
    let source = "export * from \"./m.js\";\n";
    let out = exports_tap(
      source,
      &[TapEntry {
        bindings: vec!["Hidden".to_string()],
        patch_name: "patchIt".to_string(),
        patch_from: "/abs/patch.ts".to_string(),
        alias_index: 0,
      }],
      false,
      true,
      Some("mod.js"),
      None,
      &[StarResolution {
        binding: "Hidden".to_string(),
        source: "./m.js".to_string(),
      }],
    )
    .unwrap();
    println!("{}", out.snippets);
    assert!(
      out.code.is_none(),
      "star shadowing is append-only — no rewrite"
    );
    assert!(
      out
        .snippets
        .contains("import { Hidden as __wel_l0_src } from \"./m.js\";")
    );
    assert!(out.snippets.contains("let __wel_l0 = __wel_l0_src;"));
    assert!(
      out.snippets.contains("export { __wel_l0 as Hidden };"),
      "explicit export shadows the star"
    );
    assert!(out.snippets.contains("set Hidden(v) { __wel_l0 = v; }"));
  }

  #[test]
  fn test_esm_module_exports_surface() {
    let source = "export const a = 1;\nexport * from \"./x.js\";\nexport * as ns from \"./y.js\";\nexport default 2;\n";
    let (names, stars) = esm_module_exports(source);
    assert!(names.contains(&"a".to_string()));
    assert!(
      names.contains(&"ns".to_string()),
      "export * as ns is a name, not a bare star"
    );
    assert!(names.contains(&"default".to_string()));
    assert_eq!(
      stars,
      vec!["./x.js".to_string()],
      "only the bare star is a walk source"
    );
  }

  #[test]
  fn test_exports_tap_default_reexport_split() {
    let source = "export { default as Client } from \"./client.js\";\n";
    let out = tap1(source, &["Client"], false, true).unwrap();
    let code = out
      .code
      .expect("re-exported default must take the rewrite path");
    println!("{}", code);
    assert!(code.contains("import { default as __wel_l0_src } from \"./client.js\";"));
    assert!(code.contains("export { __wel_l0 as Client }"));
  }

  #[test]
  fn test_exports_tap_export_list_of_default_import() {
    let source = "import Client from \"./client.js\";\nexport { Client };\n";
    let out = tap1(source, &["Client"], false, true).unwrap();
    let code = out.code.expect("default-import-backed export must split");
    println!("{}", code);
    assert!(code.contains("let __wel_l0 = Client;"));
    assert!(code.contains("export { __wel_l0 as Client }"));
  }

  #[test]
  fn test_exports_tap_shared_rewrites_across_entries() {
    let source = "export const VERSION = \"1.0.0\";\n";
    let entries = [
      TapEntry {
        bindings: vec!["VERSION".to_string()],
        patch_name: "patchA".to_string(),
        patch_from: "/a.ts".to_string(),
        alias_index: 0,
      },
      TapEntry {
        bindings: vec!["VERSION".to_string()],
        patch_name: "patchB".to_string(),
        patch_from: "/b.ts".to_string(),
        alias_index: 1,
      },
    ];
    let out = exports_tap(source, &entries, false, false, Some("mod.js"), None, &[]).unwrap();
    let code = out.code.unwrap();
    assert_eq!(
      code.matches("let VERSION").count(),
      1,
      "both entries share one demotion"
    );
    assert!(out.snippets.contains("__wel_patch_0"));
    assert!(out.snippets.contains("__wel_patch_1"));
  }

  #[test]
  fn test_exports_tap_missing_export_is_loud() {
    let source = "export class Client {}\nexport default 1;\n";
    let err = tap1(source, &["Klient"], false, false).unwrap_err();
    assert!(err.contains("export 'Klient' not found"));
    assert!(err.contains("Client"), "error lists what is available");
    assert!(err.contains("default"), "default is listed as available");
  }

  #[test]
  fn test_exports_tap_cjs_module_exports_binding() {
    let out = tap1("", &["module.exports"], true, true).unwrap();
    assert!(out.code.is_none(), "CJS never rewrites");
    assert!(
      out
        .snippets
        .contains("get \"module.exports\"() { return module.exports; }")
    );
    assert!(
      out
        .snippets
        .contains("set \"module.exports\"(v) { module.exports = v; }")
    );
  }

  #[test]
  fn test_exports_tap_cjs_registry_delivery() {
    let out = tap1("", &["Client"], true, true).unwrap();
    assert!(out.snippets.starts_with("\n"), "snippet is append-ready");
    assert!(
      !out.snippets.contains("require("),
      "registry delivery injects no require — hook-overridden CJS cannot serve one"
    );
    assert!(
      out
        .snippets
        .contains("get Client() { return module.exports.Client; }")
    );
    assert!(
      out
        .snippets
        .contains("set Client(v) { module.exports.Client = v;")
    );
    assert!(
      out
        .snippets
        .contains("if (module.exports.Client !== v) throw new TypeError"),
      "CJS setter must verify the rebind took — sloppy-mode bundles no-op silently on getter-only exports"
    );
  }

  #[test]
  fn test_source_map_inline() {
    let source_text =
      "export const handler = async (event) => {\n  throw new Error(\"boom\");\n};\n".to_string();
    let transformed = transform_lambda_source_with_map(
      source_text,
      "handler".to_string(),
      "WrapAwsLambda".to_string(),
      "handler.mjs".to_string(),
    );
    println!("{}", transformed);
    assert!(transformed.contains("WrapAwsLambda"));
    assert!(transformed.contains("//# sourceMappingURL=data:application/json"));
  }

  #[test]
  fn test_var_transform() {
    let source_text = r#"
      export const handler = async function(event) {
        return "Hi from AWS Lambda";
      }, other = 123;
    "#
    .to_string();
    let expected_text = "export const handler = wrapper(async function(event) {\n\treturn \"Hi from AWS Lambda\";\n}), other = 123;\n".to_string();
    let handler = "handler".to_string();
    let wrapper = "wrapper".to_string();

    let transformed = transform_lambda_source(&source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("wrapper"));
    assert!(transformed == expected_text);
  }

  #[test]
  fn test_fn_transform() {
    let source_text = r#"
      export async function handler(event) {
        return "Hi from AWS Lambda";
      }
    "#
    .to_string();
    let expected_text = "export const handler = wrapper(async function(event) {\n\treturn \"Hi from AWS Lambda\";\n});\n".to_string();
    let handler = "handler".to_string();
    let wrapper = "wrapper".to_string();

    let transformed = transform_lambda_source(&source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("wrapper"));
    assert!(transformed == expected_text);
  }

  #[test]
  fn test_export_list() {
    let source_text = r#"
      const x = 1;
      const y = async (event) => "Hi from AWS Lambda";
      export { x, y };
    "#
    .to_string();
    let handler = "y".to_string();
    let wrapper = "wrapper".to_string();

    let transformed = transform_lambda_source(&source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("const y = wrapper(async (event) => \"Hi from AWS Lambda\");"));
    assert!(transformed.contains("export { x, y };"));
  }

  #[test]
  fn test_export_renames() {
    let source_text = r#"
      const x = 1;
      const y = async (event) => "Hi from AWS Lambda";
      export { x, y as z };
    "#
    .to_string();
    let handler = "z".to_string();
    let wrapper = "wrapper".to_string();

    let transformed = transform_lambda_source(&source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("const y = wrapper(async (event) => \"Hi from AWS Lambda\");"));
    assert!(transformed.contains("export { x, y as z };"));
  }

  #[test]
  #[ignore = "object pattern destructuring is not implemented"]
  fn test_export_destructuring() {
    let source_text = r#"
const obj = {
    abc: async (event) => "Hi from AWS Lambda",
    xyz: 1
};
export const { abc: handler } = obj;
"#
    .to_string();
    let _possible_solution = r#"
const obj = {
    abc: async (event) => "Hi from AWS Lambda",
    xyz: 1
};
export const { abc: handler } = (p => { return { ...p, abc: wrapper(p.abc) }; })(obj);
"#
    .to_string();
    let handler = "handler".to_string();
    let wrapper = "wrapper".to_string();

    let transformed = transform_lambda_source(&source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("wrapper"));
  }

  #[test]
  fn test_export_from() {
    let source_text = "export { handler } from \"other.js\";".to_string();
    let handler = "handler".to_string();
    let wrapper = "wrapper".to_string();

    let transformed = transform_lambda_source(&source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("import { handler as orig_handler } from \"other.js\""));
    assert!(transformed.contains("export const handler = wrapper(orig_handler);"));
  }
}
