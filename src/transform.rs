use oxc_allocator::{Allocator, Box as ArenaBox, CloneIn, Vec as ArenaVec};
use oxc_ast::{
  NONE,
  ast::{
    Argument, Declaration, ExportNamedDeclaration, Expression, ImportOrExportKind, Program,
    Statement, VariableDeclaration, VariableDeclarationKind,
  },
};
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::{Scoping, SemanticBuilder, SymbolFlags};
use oxc_span::{Atom, SPAN, SourceType};
use oxc_traverse::{Traverse, TraverseCtx, traverse_mut};

pub struct LambdaTransform<'a> {
  handler: Atom<'a>,
  wrapper: Atom<'a>,
  orig_handler: Atom<'a>,
}

impl<'a> LambdaTransform<'a> {
  pub fn new(allocator: &'a Allocator, handler: String, wrapper: String) -> Self {
    Self {
      handler: Atom::from_strs_array_in([&handler], allocator),
      wrapper: Atom::from_strs_array_in([&wrapper], allocator),
      orig_handler: Atom::from_strs_array_in(["orig_", &handler], allocator),
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
  #[inline]
  fn enter_program(&mut self, program: &mut Program<'a>, ctx: &mut TraverseCtx<'a, ()>) {
    let mut new_stmts = ctx.ast.vec_with_capacity(program.body.len() * 2);
    for stmt in program.body.drain(..) {
      match stmt {
        Statement::ExportNamedDeclaration(export) => {
          self.transform_export_named_declaration(&mut new_stmts, export, ctx);
        }
        _ => {
          new_stmts.push(stmt);
        }
      }
    }
    program.body = new_stmts;
  }
}

impl<'a> LambdaTransform<'a> {
  fn write_orig_handler(
    &mut self,
    new_stmts: &mut ArenaVec<'a, Statement<'a>>,
    init: &Option<Expression<'a>>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) {
    let kind = VariableDeclarationKind::Const;
    let binding = ctx.generate_binding_in_current_scope(self.orig_handler, SymbolFlags::empty());
    let declarator = ctx.ast.variable_declarator(
      SPAN,
      kind,
      binding.create_binding_pattern(ctx),
      init.clone_in_with_semantic_ids(ctx.ast.allocator),
      false,
    );
    new_stmts.push(Statement::VariableDeclaration(ctx.ast.alloc(
      VariableDeclaration {
        span: SPAN,
        kind,
        declarations: ctx.ast.vec1(declarator),
        declare: false,
      },
    )));
  }

  fn write_wrap_handler(
    &mut self,
    new_stmts: &mut ArenaVec<'a, Statement<'a>>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) {
    let callee = ctx.ast.expression_identifier(SPAN, self.wrapper);
    let arguments = ctx.ast.vec_from_array([Argument::from(
      ctx.ast.expression_identifier(SPAN, self.orig_handler),
    )]);
    let init = ctx
      .ast
      .expression_call(SPAN, callee, NONE, arguments, false);
    let binding = ctx.generate_binding_in_current_scope(self.handler, SymbolFlags::empty());
    let kind = VariableDeclarationKind::Const;
    let declarator = ctx.ast.variable_declarator(
      SPAN,
      kind,
      binding.create_binding_pattern(ctx),
      Some(init),
      false,
    );
    let declaration =
      ctx
        .ast
        .alloc_variable_declaration(SPAN, kind, ctx.ast.vec1(declarator), false);
    new_stmts.push(Statement::ExportNamedDeclaration(ctx.ast.alloc(
      ExportNamedDeclaration {
        span: SPAN,
        source: None,
        specifiers: ctx.ast.vec(),
        declaration: Some(Declaration::VariableDeclaration(declaration)),
        with_clause: None,
        export_kind: ImportOrExportKind::Value,
      },
    )));
  }

  fn transform_export_named_declaration(
    &mut self,
    new_stmts: &mut ArenaVec<'a, Statement<'a>>,
    export: ArenaBox<'a, ExportNamedDeclaration<'a>>,
    ctx: &mut TraverseCtx<'a, ()>,
  ) {
    let export = export.unbox();
    if let Some(declaration) = export.declaration {
      if let Declaration::VariableDeclaration(var) = &declaration {
        let found = var
          .declarations
          .iter()
          .find(|x| x.id.get_identifier_name() == Some(self.handler));
        if found.is_some() {
          let init = &found.unwrap().init;
          assert!(init.is_some());
          self.write_orig_handler(new_stmts, init, ctx);
          self.write_wrap_handler(new_stmts, ctx);
          return;
        }
      };
      new_stmts.push(Statement::ExportNamedDeclaration(ctx.ast.alloc(
        ExportNamedDeclaration {
          span: SPAN,
          source: export.source,
          specifiers: export.specifiers,
          declaration: Some(declaration),
          with_clause: export.with_clause,
          export_kind: export.export_kind,
        },
      )));
    }
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
