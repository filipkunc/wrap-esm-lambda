//! The privates bridge — the class-body injection behind the declarative
//! `privates` config field (docs/design-private-bindings.md), the native
//! twin of the acorn engine's `privates.mts`. `#field` is brand-scoped to
//! the class body's lexical scope, so runtime patches can never reach it;
//! the transform owns the AST before evaluation, where the class body is
//! just structure. Seeing `privates`, the tap injects a static block into
//! the named class's body — the one place the brand is legal — publishing
//! get/set closures under a well-known symbol:
//!
//! ```js
//! static {
//!   Object.defineProperty(this, Symbol.for("wrap-esm-lambda.privates"), { value: { ... } });
//! }
//! ```
//!
//! The member is not built node-by-node: [`apply_private_bridges`] renders
//! it as source text inside a synthetic class (declaring the referenced
//! private names so the parser's brand check passes), parses that, and
//! grafts the parsed static block into the target class body. Codegen then
//! prints it with its normal structural formatting — which is exactly the
//! text the acorn engine's `memberText` emits by hand, and the
//! engine-parity suite diffs the two. Grafted spans are zeroed first so the
//! rewrite's source map never points into the synthetic source.
//!
//! Everything contract-relevant here mirrors the acorn engine byte for
//! byte: the slot capability rules (fields read+write, methods and get-only
//! accessors read, set-only accessors write), the merge of several entries
//! into one block per class, and the refusal messages — which deliberately
//! avoid the "not found in module" phrasing that core's
//! `isMissingExportError` keys the star-graph retry on.

use indexmap::IndexMap;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
  Class, ClassElement, Declaration, ExportDefaultDeclarationKind, Expression, MethodDefinitionKind,
  Program, PropertyKey, Statement, VariableDeclaration,
};
use oxc_ast_visit::VisitMut;
use oxc_parser::Parser;
use oxc_span::{SPAN, SourceType, Span};

use super::snippet::quote_js_string;

/// The well-known registry key: patches read the bridge off the class
/// binding via `Symbol.for(PRIVATE_BRIDGE_KEY)`.
pub(crate) const PRIVATE_BRIDGE_KEY: &str = "wrap-esm-lambda.privates";

/// Where a named class lives in the program body, as indices — held instead
/// of references so planning (immutable) and grafting (mutable) can be two
/// separate borrows of the program.
#[derive(Clone, Copy)]
enum ClassSite {
  /// `class X {}` at `body[stmt]`
  Decl { stmt: usize },
  /// `export class X {}` at `body[stmt]`
  ExportDecl { stmt: usize },
  /// `export default class X {}` (named) at `body[stmt]`
  ExportDefault { stmt: usize },
  /// `let X = class {}` — declarator `decl` of the declaration at `body[stmt]`
  Var { stmt: usize, decl: usize },
  /// `export let X = class {}` — same, behind the export
  ExportVar { stmt: usize, decl: usize },
}

/// What the class body statically grants for one private name.
struct Slot {
  name: String,
  readable: bool,
  writable: bool,
}

/// One planned injection: which class, and the member as source text ready
/// for the synthetic parse (plus the private names it references, which the
/// synthetic class must declare).
pub(crate) struct BridgePlan {
  site: ClassSite,
  member_source: String,
  decl_names: Vec<String>,
}

/// The `privates` requests of every entry, merged per class in first-seen
/// order — several entries bridging the same class converge on ONE injected
/// static block, exactly as overlapping binding taps converge on one
/// rewrite. Empty name lists are dropped: they request nothing.
pub(crate) fn merged_privates(entries: &[super::TapEntry]) -> IndexMap<String, Vec<String>> {
  let mut merged: IndexMap<String, Vec<String>> = IndexMap::new();
  for entry in entries {
    let Some(privates) = &entry.privates else {
      continue;
    };
    for (class_name, names) in privates {
      if names.is_empty() {
        continue;
      }
      let known = merged.entry(class_name.clone()).or_default();
      for name in names {
        if !known.contains(name) {
          known.push(name.clone());
        }
      }
    }
  }
  merged
}

/// Every named class the bridge can target, in source order: top-level
/// class declarations (exported or not, including a NAMED `export default
/// class`) and class expressions initializing a top-level declarator.
/// Anonymous default classes and nested/inner classes have no name to key
/// `privates` on and are not collected.
fn collect_classes(program: &Program) -> IndexMap<String, ClassSite> {
  let mut classes: IndexMap<String, ClassSite> = IndexMap::new();
  let mut add = |name: &str, site: ClassSite| {
    classes.entry(name.to_string()).or_insert(site);
  };
  /// The `name = class {...}` declarators of one variable declaration.
  fn class_declarators(var: &VariableDeclaration) -> Vec<(String, usize)> {
    var
      .declarations
      .iter()
      .enumerate()
      .filter_map(|(decl_idx, declarator)| match &declarator.id {
        oxc_ast::ast::BindingPattern::BindingIdentifier(id)
          if matches!(&declarator.init, Some(Expression::ClassExpression(_))) =>
        {
          Some((id.name.to_string(), decl_idx))
        }
        _ => None,
      })
      .collect()
  }
  for (stmt_idx, stmt) in program.body.iter().enumerate() {
    match stmt {
      Statement::ClassDeclaration(class) => {
        if let Some(id) = &class.id {
          add(id.name.as_str(), ClassSite::Decl { stmt: stmt_idx });
        }
      }
      Statement::VariableDeclaration(var) => {
        for (name, decl) in class_declarators(var) {
          add(
            &name,
            ClassSite::Var {
              stmt: stmt_idx,
              decl,
            },
          );
        }
      }
      Statement::ExportNamedDeclaration(export) => match &export.declaration {
        Some(Declaration::ClassDeclaration(class)) => {
          if let Some(id) = &class.id {
            add(id.name.as_str(), ClassSite::ExportDecl { stmt: stmt_idx });
          }
        }
        Some(Declaration::VariableDeclaration(var)) => {
          for (name, decl) in class_declarators(var) {
            add(
              &name,
              ClassSite::ExportVar {
                stmt: stmt_idx,
                decl,
              },
            );
          }
        }
        _ => {}
      },
      Statement::ExportDefaultDeclaration(export) => {
        if let ExportDefaultDeclarationKind::ClassDeclaration(class) = &export.declaration
          && let Some(id) = &class.id
        {
          add(
            id.name.as_str(),
            ClassSite::ExportDefault { stmt: stmt_idx },
          );
        }
      }
      _ => {}
    }
  }
  classes
}

fn class_at<'b, 'a>(program: &'b Program<'a>, site: ClassSite) -> Option<&'b Class<'a>> {
  match site {
    ClassSite::Decl { stmt } => match &program.body[stmt] {
      Statement::ClassDeclaration(class) => Some(class),
      _ => None,
    },
    ClassSite::ExportDecl { stmt } => match &program.body[stmt] {
      Statement::ExportNamedDeclaration(export) => match &export.declaration {
        Some(Declaration::ClassDeclaration(class)) => Some(class),
        _ => None,
      },
      _ => None,
    },
    ClassSite::ExportDefault { stmt } => match &program.body[stmt] {
      Statement::ExportDefaultDeclaration(export) => match &export.declaration {
        ExportDefaultDeclarationKind::ClassDeclaration(class) => Some(class),
        _ => None,
      },
      _ => None,
    },
    ClassSite::Var { stmt, decl } => match &program.body[stmt] {
      Statement::VariableDeclaration(var) => match &var.declarations[decl].init {
        Some(Expression::ClassExpression(class)) => Some(class),
        _ => None,
      },
      _ => None,
    },
    ClassSite::ExportVar { stmt, decl } => match &program.body[stmt] {
      Statement::ExportNamedDeclaration(export) => match &export.declaration {
        Some(Declaration::VariableDeclaration(var)) => match &var.declarations[decl].init {
          Some(Expression::ClassExpression(class)) => Some(class),
          _ => None,
        },
        _ => None,
      },
      _ => None,
    },
  }
}

fn class_at_mut<'b, 'a>(
  program: &'b mut Program<'a>,
  site: ClassSite,
) -> Option<&'b mut Class<'a>> {
  match site {
    ClassSite::Decl { stmt } => match &mut program.body[stmt] {
      Statement::ClassDeclaration(class) => Some(class),
      _ => None,
    },
    ClassSite::ExportDecl { stmt } => match &mut program.body[stmt] {
      Statement::ExportNamedDeclaration(export) => match &mut export.declaration {
        Some(Declaration::ClassDeclaration(class)) => Some(class),
        _ => None,
      },
      _ => None,
    },
    ClassSite::ExportDefault { stmt } => match &mut program.body[stmt] {
      Statement::ExportDefaultDeclaration(export) => match &mut export.declaration {
        ExportDefaultDeclarationKind::ClassDeclaration(class) => Some(class),
        _ => None,
      },
      _ => None,
    },
    ClassSite::Var { stmt, decl } => match &mut program.body[stmt] {
      Statement::VariableDeclaration(var) => match &mut var.declarations[decl].init {
        Some(Expression::ClassExpression(class)) => Some(class),
        _ => None,
      },
      _ => None,
    },
    ClassSite::ExportVar { stmt, decl } => match &mut program.body[stmt] {
      Statement::ExportNamedDeclaration(export) => match &mut export.declaration {
        Some(Declaration::VariableDeclaration(var)) => match &mut var.declarations[decl].init {
          Some(Expression::ClassExpression(class)) => Some(class),
          _ => None,
        },
        _ => None,
      },
      _ => None,
    },
  }
}

/// The private names a class body declares, each with what the language
/// permits on it: fields read and write; methods and getters read; setters
/// write. Accessor pairs merge (`get #x` + `set #x` grants both). Static
/// privates are included as-is — the closures take the receiver as an
/// argument, and for a static private that receiver is the class itself.
fn scan_slots(class: &Class) -> IndexMap<String, Slot> {
  let mut slots: IndexMap<String, Slot> = IndexMap::new();
  let mut grant = |bare: &str, readable: bool, writable: bool| {
    let name = format!("#{bare}");
    let slot = slots.entry(name.clone()).or_insert(Slot {
      name,
      readable: false,
      writable: false,
    });
    slot.readable |= readable;
    slot.writable |= writable;
  };
  for element in &class.body.body {
    match element {
      ClassElement::PropertyDefinition(prop) => {
        if let PropertyKey::PrivateIdentifier(key) = &prop.key {
          grant(key.name.as_str(), true, true);
        }
      }
      ClassElement::MethodDefinition(method) => {
        if let PropertyKey::PrivateIdentifier(key) = &method.key {
          match method.kind {
            MethodDefinitionKind::Set => grant(key.name.as_str(), false, true),
            _ => grant(key.name.as_str(), true, false),
          }
        }
      }
      _ => {}
    }
  }
  slots
}

/// One bridge entry as compact source text for the synthetic parse — the
/// formatting here is irrelevant (codegen reprints structurally); only the
/// structure must match what the acorn engine's `memberText` prints.
fn slot_text(slot: &Slot) -> String {
  let mut parts: Vec<String> = Vec::new();
  if slot.readable {
    parts.push(format!("get: (o) => o.{}", slot.name));
  }
  if slot.writable {
    parts.push(format!("set: (o, v) => {{ o.{} = v; }}", slot.name));
  }
  format!(
    "{}: {{ {} }}",
    quote_js_string(&slot.name),
    parts.join(", ")
  )
}

/// Validate every requested private against the class bodies and plan the
/// injections. All refusals surface here, BEFORE any AST mutation, phrased
/// for `validateConfig` to report ahead of load time — and shared verbatim
/// with the acorn engine. Deliberately NOT worded "not found in module":
/// that phrase is the tap contract's missing-EXPORT alarm
/// (`isMissingExportError` in core keys the star-graph retry on it), and a
/// privates refusal must never trigger it.
pub(crate) fn plan_private_bridges(
  program: &Program,
  privates: &IndexMap<String, Vec<String>>,
) -> Result<Vec<BridgePlan>, String> {
  if privates.is_empty() {
    return Ok(Vec::new());
  }
  let classes = collect_classes(program);
  let mut plans = Vec::new();
  for (class_name, names) in privates {
    let Some(&site) = classes.get(class_name) else {
      let known: Vec<&str> = classes.keys().map(String::as_str).collect();
      let hint = if known.is_empty() {
        "no named top-level classes".to_string()
      } else {
        format!("top-level classes: {}", known.join(", "))
      };
      return Err(format!(
        "privates: no top-level class named '{class_name}' ({hint})"
      ));
    };
    let class = class_at(program, site).ok_or("internal: class site does not hold a class")?;
    let slots = scan_slots(class);
    let mut members = Vec::with_capacity(names.len());
    for name in names {
      let Some(slot) = slots.get(name) else {
        let available: Vec<&str> = slots.keys().map(String::as_str).collect();
        let available = if available.is_empty() {
          "none".to_string()
        } else {
          available.join(", ")
        };
        return Err(format!(
          "privates: '{name}' not found in class '{class_name}' (available: {available})"
        ));
      };
      members.push(slot_text(slot));
    }
    plans.push(BridgePlan {
      site,
      member_source: format!(
        "static {{ Object.defineProperty(this, Symbol.for({}), {{ value: {{ {} }} }}); }}",
        quote_js_string(PRIVATE_BRIDGE_KEY),
        members.join(", ")
      ),
      decl_names: names.clone(),
    });
  }
  Ok(plans)
}

/// Reset every span in the grafted subtree: the member was parsed from a
/// synthetic source, and its offsets must not leak into the rewrite's
/// source map as positions in the real module.
struct ZeroSpans;

impl<'a> VisitMut<'a> for ZeroSpans {
  fn visit_span(&mut self, it: &mut Span) {
    *it = SPAN;
  }
}

/// Graft each planned bridge member into its class body as the last
/// element, by parsing a synthetic class that declares the referenced
/// private names (so the parser's brand check accepts the member) and
/// moving the parsed static block over.
pub(crate) fn apply_private_bridges<'a>(
  allocator: &'a Allocator,
  program: &mut Program<'a>,
  plans: Vec<BridgePlan>,
) -> Result<(), String> {
  for plan in plans {
    let decls: String = plan
      .decl_names
      .iter()
      .map(|name| format!("{name};"))
      .collect();
    let synthetic: &'a str = allocator.alloc_str(&format!(
      "class __WelPrivatesBridge {{\n{decls}\n{}\n}}\n",
      plan.member_source
    ));
    let parsed = Parser::new(allocator, synthetic, SourceType::mjs()).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
      return Err(format!(
        "internal: the synthetic privates-bridge member failed to parse: {:?}",
        parsed.diagnostics
      ));
    }
    let mut synthetic_program = parsed.program;
    let Some(Statement::ClassDeclaration(mut class)) = synthetic_program.body.pop() else {
      return Err("internal: the synthetic privates-bridge source is not a class".to_string());
    };
    let Some(mut element) = class.body.body.pop() else {
      return Err("internal: the synthetic privates-bridge class is empty".to_string());
    };
    if !matches!(element, ClassElement::StaticBlock(_)) {
      return Err(
        "internal: the synthetic privates-bridge member is not a static block".to_string(),
      );
    }
    ZeroSpans.visit_class_element(&mut element);
    let target =
      class_at_mut(program, plan.site).ok_or("internal: class site does not hold a class")?;
    target.body.body.push(element);
  }
  Ok(())
}
