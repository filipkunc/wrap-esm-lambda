use oxc_allocator::{Allocator, Box as ArenaBox, CloneIn, Vec as ArenaVec};
use oxc_ast::{
  NONE,
  ast::{
    Argument, BindingPattern, Declaration, ExportNamedDeclaration, Expression, ImportOrExportKind,
    ModuleExportName, Program, Statement, VariableDeclaration, VariableDeclarationKind,
    VariableDeclarator,
  },
};
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder, SymbolFlags};
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

pub fn transform_lambda_source(source_text: String, handler: String, wrapper: String) -> String {
  let allocator = Allocator::default();
  let parsed = Parser::new(&allocator, &source_text, SourceType::mjs()).parse();
  let mut program = parsed.program;
  let scoping = SemanticBuilder::new()
    .build(&program)
    .semantic
    .into_scoping();
  LambdaTransform::new(&allocator, handler, wrapper).transform(&allocator, &mut program, scoping);
  Codegen::new().build(&program).code
}

#[cfg(test)]
mod tests {
  use super::*;

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
