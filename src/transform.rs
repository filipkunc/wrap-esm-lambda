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
use oxc_span::{SPAN, SourceType};
use oxc_str::Ident;
use oxc_transformer::{TransformOptions, Transformer};
use oxc_traverse::{Traverse, TraverseCtx, traverse_mut};
use std::path::Path;

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

/// `.ts`/`.mts`/`.cts` (and `.tsx`) get oxc's own TypeScript source type, so a
/// `.ts` handler can be parsed and stripped directly; anything else keeps the
/// plain ESM source type used before TypeScript support existed.
fn source_type_for_path(path: &Path) -> SourceType {
  match path.extension().and_then(|ext| ext.to_str()) {
    Some("ts" | "mts" | "cts") => SourceType::ts(),
    Some("tsx") => SourceType::tsx(),
    _ => SourceType::mjs(),
  }
}

/// Parse `source_text`, wrap the handler, and generate code. When
/// `source_map_path` is `Some`, oxc also emits a source map (relative to that
/// path). When `None`, no map is generated (the fast path used by callers that
/// only need the transformed code).
///
/// When the path's extension marks it as TypeScript, oxc strips the types
/// itself before wrapping, so `.ts` handlers don't need a separate `tsc` pass:
/// the generated map goes straight from the wrapped code back to the original
/// `.ts`, with no upstream map to compose.
fn transform_and_generate(
  source_text: &str,
  handler: String,
  wrapper: String,
  source_map_path: Option<std::path::PathBuf>,
) -> (String, Option<MapOutput>) {
  let allocator = Allocator::default();
  let default_path = std::path::PathBuf::from("input.mjs");
  let path = source_map_path.as_ref().unwrap_or(&default_path);
  let source_type = source_type_for_path(path);
  let parsed = Parser::new(&allocator, source_text, source_type).parse();
  let mut program = parsed.program;
  let mut scoping = SemanticBuilder::new()
    .build(&program)
    .semantic
    .into_scoping();
  if source_type.is_typescript() {
    let transformed = Transformer::new(&allocator, path, &TransformOptions::default())
      .build_with_scoping(scoping, &mut program);
    scoping = transformed.scoping;
  }
  LambdaTransform::new(&allocator, handler, wrapper).transform(&allocator, &mut program, scoping);
  let ret = Codegen::new()
    .with_options(CodegenOptions {
      source_map_path,
      ..CodegenOptions::default()
    })
    .build(&program);
  let map = ret.map.as_ref().map(|map| MapOutput {
    json: map.to_json_string(),
    data_url: map.to_data_url(),
  });
  (ret.code, map)
}

pub fn transform_lambda_source(source_text: String, handler: String, wrapper: String) -> String {
  transform_and_generate(&source_text, handler, wrapper, None).0
}

/// Same as [`transform_lambda_source`], but appends an inline
/// `//# sourceMappingURL=` data-URL source map that maps the generated code
/// back to `filename`. The wrapped handler body keeps its original spans, so an
/// exception thrown inside the handler resolves to the original source line
/// under Node's `--enable-source-maps`.
///
/// If `filename` ends in `.ts`/`.mts`/`.cts`/`.tsx`, `source_text` is parsed
/// and type-stripped by oxc directly (no `tsc` pass needed), so the map goes
/// straight from the wrapped code back to that `.ts` source.
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
  );
  if let Some(map) = map {
    code.push_str("\n//# sourceMappingURL=");
    code.push_str(&map.data_url);
    code.push('\n');
  }
  code
}

/// Like [`transform_lambda_source_with_map`], but returns the code and the raw
/// v3 source map JSON separately (no inline URL appended).
///
/// For a `filename` that already ends in `.js`/`.mjs`/`.cjs` (e.g. `tsc`
/// output), the JSON is `transformed -> filename`, which a caller composes
/// with an upstream `.ts` -> `.js` map so the final map reaches the original
/// TypeScript. For a `.ts`/`.mts`/`.cts`/`.tsx` `filename`, pass the original
/// TypeScript `source_text` directly: oxc strips the types itself and the
/// returned map already reaches that `.ts` source, so there is nothing left to
/// compose.
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
  );
  (code, map.map(|map| map.json))
}

#[cfg(test)]
mod tests {
  use super::*;

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
  fn test_source_map_from_ts() {
    // No tsc involved: oxc parses and strips the .ts types itself, so the map
    // (and its embedded sourcesContent) reaches handler.ts directly.
    let source_text = "export const handler = async (event: { id?: number }): Promise<string> => {\n  throw new Error(`boom ${event?.id}`);\n};\n".to_string();
    let (code, map) = transform_lambda_source_with_map_json(
      source_text.clone(),
      "handler".to_string(),
      "WrapAwsLambda".to_string(),
      "handler.ts".to_string(),
    );
    assert!(code.contains("WrapAwsLambda("));
    assert!(!code.contains(": {"), "type annotations should be stripped");
    let map = map.expect("map should be generated for a .ts filename");
    assert!(map.contains("\"sources\":[\"handler.ts\"]"));
    assert!(map.contains("\"sourcesContent\":[\"export const handler"));
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

    let transformed = transform_lambda_source(source_text, handler, wrapper);
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

    let transformed = transform_lambda_source(source_text, handler, wrapper);
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

    let transformed = transform_lambda_source(source_text, handler, wrapper);
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

    let transformed = transform_lambda_source(source_text, handler, wrapper);
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

    let transformed = transform_lambda_source(source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("wrapper"));
  }

  #[test]
  fn test_export_from() {
    let source_text = "export { handler } from \"other.js\";".to_string();
    let handler = "handler".to_string();
    let wrapper = "wrapper".to_string();

    let transformed = transform_lambda_source(source_text, handler, wrapper);
    println!("{}", transformed);
    assert!(transformed.contains("import { handler as orig_handler } from \"other.js\""));
    assert!(transformed.contains("export const handler = wrapper(orig_handler);"));
  }
}
