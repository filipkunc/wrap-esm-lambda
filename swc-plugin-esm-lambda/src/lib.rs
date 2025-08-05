use swc_core::ecma::ast::ExprOrSpread;
use swc_core::plugin::{plugin_transform, proxies::TransformPluginProgramMetadata};
use swc_core::{
  atoms::{atom, Atom},
  common::{Span, DUMMY_SP},
  ecma::{
    ast::{CallExpr, Callee, Decl, ExportDecl, Expr, Id, Ident, Pat, Program},
    transforms::testing::test_inline,
    visit::{visit_mut_pass, VisitMut, VisitMutWith},
  },
};

pub struct TransformVisitor;

impl VisitMut for TransformVisitor {
  // Implement necessary visit_mut_* methods for actual custom transform.
  // A comprehensive list of possible visitor methods can be found here:
  // https://rustdoc.swc.rs/swc_ecma_visit/trait.VisitMut.html
  fn visit_mut_export_decl(&mut self, node: &mut ExportDecl) {
    node.visit_mut_children_with(self);
    if let Decl::Var(var_decl) = &mut node.decl {
      let var_decl = &mut var_decl.decls[0];
      if let Pat::Ident(i) = &mut var_decl.name {
        if &*i.sym == "handler" {
          //i.sym = "abc".into();
          var_decl.init = Some(Box::new(Expr::Call(CallExpr {
            span: DUMMY_SP,
            callee: Callee::Expr(Box::new(Expr::Ident(Ident::new_no_ctxt(
              atom!("WrapAwsLambda"),
              DUMMY_SP,
            )))),
            args: vec![ExprOrSpread {
              spread: None,
              expr: var_decl.init.clone().unwrap(),
            }],
            ..Default::default()
          })));
        }
      }
    }
  }
}

/// An example plugin function with macro support.
/// `plugin_transform` macro interop pointers into deserialized structs, as well
/// as returning ptr back to host.
///
/// It is possible to opt out from macro by writing transform fn manually
/// if plugin need to handle low-level ptr directly via
/// `__transform_plugin_process_impl(
///     ast_ptr: *const u8, ast_ptr_len: i32,
///     unresolved_mark: u32, should_enable_comments_proxy: i32) ->
///     i32 /*  0 for success, fail otherwise.
///             Note this is only for internal pointer interop result,
///             not actual transform result */`
///
/// This requires manual handling of serialization / deserialization from ptrs.
/// Refer swc_plugin_macro to see how does it work internally.
#[plugin_transform]
pub fn process_transform(program: Program, _metadata: TransformPluginProgramMetadata) -> Program {
  program.apply(&mut visit_mut_pass(TransformVisitor))
}

// An example to test plugin transform.
// Recommended strategy to test plugin's transform is verify
// the Visitor's behavior, instead of trying to run `process_transform` with mocks
// unless explicitly required to do so.
test_inline!(
  Default::default(),
  |_| visit_mut_pass(TransformVisitor),
  boo,
  // Input codes
  r#"export const handler = async () => { return "Hi from AWS Lambda"; };"#,
  // Output codes after transformed with plugin
  r#"export const abc = async () => { return "Hi from AWS Lambda"; };"#
);
