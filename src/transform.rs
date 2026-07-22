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

/// An exported binding usable by the exports tap: its exported name, the local
/// identifier behind it, and whether the local binding can be reassigned
/// (`let`/`var`/function/class declarations can, `const` cannot).
struct TapBinding {
  exported: String,
  local: String,
  reassignable: bool,
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

/// Collect the statically-analyzable exported bindings of an ESM module:
/// `export const/let/var/function/class ...` and local `export { a as b }`
/// lists. Re-exports (`export ... from`) have no local binding and are not
/// tappable. `export { a as b }` specifiers are treated as reassignable — if
/// the local turns out to be a `const`, the setter throws at runtime, which is
/// still a loud failure.
fn collect_esm_exports(program: &Program) -> Vec<TapBinding> {
  let mut out = Vec::new();
  for stmt in &program.body {
    let Statement::ExportNamedDeclaration(export) = stmt else {
      continue;
    };
    if let Some(declaration) = &export.declaration {
      match declaration {
        Declaration::VariableDeclaration(var) => {
          let reassignable = var.kind != VariableDeclarationKind::Const;
          for decl in &var.declarations {
            if let BindingPattern::BindingIdentifier(ident) = &decl.id {
              out.push(TapBinding {
                exported: ident.name.to_string(),
                local: ident.name.to_string(),
                reassignable,
              });
            }
          }
        }
        Declaration::FunctionDeclaration(func) => {
          if let Some(name) = func.name() {
            out.push(TapBinding {
              exported: name.to_string(),
              local: name.to_string(),
              reassignable: true,
            });
          }
        }
        Declaration::ClassDeclaration(class) => {
          if let Some(ident) = &class.id {
            out.push(TapBinding {
              exported: ident.name.to_string(),
              local: ident.name.to_string(),
              reassignable: true,
            });
          }
        }
        _ => {}
      }
    } else if export.source.is_none() {
      for specifier in &export.specifiers {
        if let Some(exported) = specifier.exported.identifier_name() {
          out.push(TapBinding {
            exported: exported.to_string(),
            local: specifier.local.name().to_string(),
            reassignable: true,
          });
        }
      }
    }
  }
  out
}

/// Append the get/set accessor properties for the tapped bindings. `local` is
/// how the module reaches the value (a local identifier for ESM, a
/// `module.exports.X` path for CJS); a missing setter makes assignment throw
/// loudly in strict mode.
fn push_accessors(out: &mut String, bindings: &[(String, String, bool)]) {
  for (exported, local, reassignable) in bindings {
    out.push_str("\n  get ");
    out.push_str(exported);
    out.push_str("() { return ");
    out.push_str(local);
    out.push_str("; },");
    if *reassignable {
      out.push_str("\n  set ");
      out.push_str(exported);
      out.push_str("(v) { ");
      out.push_str(local);
      out.push_str(" = v; },");
    }
  }
}

/// The generic "exports tap": produce the statements a caller appends after a
/// module's source, calling a user-provided patch function with the module's
/// live bindings as get/set accessors. Only the *snippet* is returned — the
/// caller concatenates it in JS. Round-tripping the full module source across
/// the napi boundary just to append a few hundred bytes costs two O(n)
/// UTF-16<->UTF-8 conversions and dominated the measured latency (a 42 KB CJS
/// file: ~39 µs round-tripped vs ~0.7 µs snippet-only).
///
/// Appending (never restructuring) keeps every original line — and therefore
/// any existing source map — intact, and because the call runs at the end of
/// the module's own evaluation the patch sees fully-initialized definitions
/// before any importer does.
///
/// ESM (`cjs = false`): `source_text` is parsed and the requested names are
/// validated against the module's statically visible exports (a missing
/// export is a hard error — the version-drift alarm); accessors close over
/// the local bindings, so `bindings.X = wrapped` rebinds the live export
/// where the binding kind allows it.
///
/// CJS (`cjs = true`): bundled CJS keeps internals out of top-level scope, so
/// accessors go through `module.exports` instead — which also works with the
/// getter-only exports esbuild-bundled packages define. No static validation
/// is possible there, so `source_text` is ignored entirely — pass an empty
/// string and skip the input conversion too.
///
/// Delivery of the patch function differs per mode:
/// - `registry = false` (build time): a static import of `patch_from` is
///   emitted (aliased by `alias_index` so several patches can share a
///   module); the bundler resolves and bundles the user's patch code.
/// - `registry = true` (runtime): no import at all — the emission looks the
///   patch up in `globalThis[Symbol.for("wrap-esm-lambda.patches")]` under
///   the key `"<patch_from>#<patch_name>"`, which the runtime shell populates
///   before any module loads. This keeps hook-overridden CJS sources free of
///   injected `require` calls, which Node's CJS-over-ESM translator cannot
///   serve.
pub fn exports_tap_snippet(
  source_text: &str,
  bindings: Vec<String>,
  patch_name: &str,
  patch_from: &str,
  cjs: bool,
  registry: bool,
  alias_index: u32,
) -> Result<String, String> {
  let accessors: Vec<(String, String, bool)> = if cjs {
    bindings
      .iter()
      .map(|name| (name.clone(), format!("module.exports.{}", name), true))
      .collect()
  } else {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source_text, SourceType::mjs()).parse();
    let exports = collect_esm_exports(&parsed.program);
    let mut resolved = Vec::with_capacity(bindings.len());
    for name in &bindings {
      let Some(binding) = exports.iter().find(|b| &b.exported == name) else {
        return Err(format!(
          "export '{}' not found in module (available: {})",
          name,
          exports
            .iter()
            .map(|b| b.exported.as_str())
            .collect::<Vec<_>>()
            .join(", ")
        ));
      };
      resolved.push((
        binding.exported.clone(),
        binding.local.clone(),
        binding.reassignable,
      ));
    }
    resolved
  };

  let mut out = String::with_capacity(512);
  if registry {
    let key = format!("{}#{}", patch_from, patch_name);
    out.push_str("\n;(() => {\nconst __wel_registry = globalThis[Symbol.for(\"wrap-esm-lambda.patches\")];\nconst __wel_patch = __wel_registry && __wel_registry[");
    out.push_str(&quote_js_string(&key));
    out.push_str("];\nif (__wel_patch) __wel_patch({");
    push_accessors(&mut out, &accessors);
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
    push_accessors(&mut out, &accessors);
    out.push_str("\n});\n");
  }
  Ok(out)
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

  #[test]
  fn test_exports_tap_esm_import_delivery() {
    let source = "export class Client {\n\tsend(command) {\n\t\treturn command;\n\t}\n}\nexport const VERSION = \"1.0.0\";\n";
    let out = exports_tap_snippet(
      source,
      vec!["Client".to_string(), "VERSION".to_string()],
      "patchSmithy",
      "./patches/smithy.ts",
      false,
      false,
      0,
    )
    .unwrap();
    println!("{}", out);
    assert!(
      !out.contains("export class"),
      "snippet must not contain the source"
    );
    assert!(out.contains("import { patchSmithy as __wel_patch_0 } from \"./patches/smithy.ts\";"));
    assert!(out.contains("get Client() { return Client; }"));
    assert!(out.contains("set Client(v) { Client = v; }"));
    assert!(out.contains("get VERSION() { return VERSION; }"));
    // const exports get no setter
    assert!(!out.contains("set VERSION"));
  }

  #[test]
  fn test_exports_tap_esm_registry_delivery() {
    let source = "export class Client {}\n";
    let out = exports_tap_snippet(
      source,
      vec!["Client".to_string()],
      "patchSmithy",
      "/abs/patches/smithy.ts",
      false,
      true,
      0,
    )
    .unwrap();
    println!("{}", out);
    assert!(out.starts_with("\n"), "snippet is append-ready");
    assert!(
      !out.contains("import {"),
      "registry delivery injects no import"
    );
    assert!(out.contains("globalThis[Symbol.for(\"wrap-esm-lambda.patches\")]"));
    assert!(out.contains("[\"/abs/patches/smithy.ts#patchSmithy\"]"));
    assert!(out.contains("get Client() { return Client; }"));
  }

  #[test]
  fn test_exports_tap_esm_missing_export_is_loud() {
    let source = "export class Client {}\n";
    let err = exports_tap_snippet(
      source,
      vec!["Klient".to_string()],
      "patch",
      "./p.ts",
      false,
      false,
      0,
    )
    .unwrap_err();
    assert!(err.contains("export 'Klient' not found"));
    assert!(err.contains("Client"));
  }

  #[test]
  fn test_exports_tap_cjs_registry_delivery() {
    let source = "class Client {}\nmodule.exports.Client = Client;\n";
    let out = exports_tap_snippet(
      source,
      vec!["Client".to_string()],
      "patchSmithy",
      "/abs/patches/smithy.ts",
      true,
      true,
      0,
    )
    .unwrap();
    println!("{}", out);
    assert!(out.starts_with("\n"), "snippet is append-ready");
    assert!(
      !out.contains("require("),
      "registry delivery injects no require — hook-overridden CJS cannot serve one"
    );
    assert!(out.contains("[\"/abs/patches/smithy.ts#patchSmithy\"]"));
    assert!(out.contains("get Client() { return module.exports.Client; }"));
    assert!(out.contains("set Client(v) { module.exports.Client = v; }"));
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
