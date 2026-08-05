//! Everything the tap emits as plain JS text: the get/set accessor
//! properties, the guarded patch call, the per-entry delivery snippet
//! (registry lookup, static import, or CJS `require`), and the append-only
//! shadow exports for star-forwarded names. Pure string building — no AST,
//! no parsing.

/// Minimal JS string literal escaping for generated specifiers.
pub(crate) fn quote_js_string(value: &str) -> String {
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

/// One get/set accessor pair handed to a patch function: how consumers name
/// the binding (`exported`) and how the module reaches its value (`local` —
/// a local identifier for ESM, a `module.exports.X` path for CJS), plus the
/// two switches `push_accessors` documents: whether a setter is emitted at
/// all, and whether that setter re-reads the property to verify the rebind
/// took.
pub(crate) struct Accessor {
  pub(crate) exported: String,
  pub(crate) local: String,
  pub(crate) reassignable: bool,
  pub(crate) verify_set: bool,
}

/// True when `name` can appear bare as an object-literal property name.
pub(crate) fn is_plain_property_name(name: &str) -> bool {
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
fn push_accessors(out: &mut String, bindings: &[Accessor]) {
  for accessor in bindings {
    let quoted;
    let name: &str = if is_plain_property_name(&accessor.exported) {
      &accessor.exported
    } else {
      quoted = quote_js_string(&accessor.exported);
      &quoted
    };
    out.push_str("\n  get ");
    out.push_str(name);
    out.push_str("() { return ");
    out.push_str(&accessor.local);
    out.push_str("; },");
    if accessor.reassignable {
      out.push_str("\n  set ");
      out.push_str(name);
      out.push_str("(v) { ");
      out.push_str(&accessor.local);
      out.push_str(" = v;");
      if accessor.verify_set {
        out.push_str(" if (");
        out.push_str(&accessor.local);
        out.push_str(" !== v) throw new TypeError(\"wrap-esm-lambda: rebinding ");
        out.push_str(&accessor.exported);
        out.push_str(" had no effect (getter-only CJS export)\");");
      }
      out.push_str(" },");
    }
  }
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
pub(crate) fn push_star_stub(stubs: &mut String, name: &str, source: &str, local: &str) {
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

/// The patch call itself, in import delivery: wrapped so a throwing patch
/// cannot break the evaluation of the module it patches. The runtime shell
/// contains that failure in the function it registers (see
/// `@wrap-esm-lambda/hooks`, guardPatch), but a bundled artifact has no
/// registry to wrap — the emitted code calls the user's function directly, so
/// the containment has to be emitted too.
///
/// Deliberate properties of the emitted guard: it reads
/// WRAP_ESM_LAMBDA_STRICT with the same semantics as the runtime shell (unset,
/// empty, `0` and `false` are all off), it tolerates a `process`-less bundle
/// rather than throwing a second error out of the catch block, and it reports
/// with the same message shape the runtime uses so one grep finds both. The
/// `__wel_err`/`__wel_s` bindings are block-scoped to the catch, so several
/// entries in one module cannot collide.
fn push_guarded_call(out: &mut String, alias: &str, key: &str, accessors: &[Accessor]) {
  out.push_str("try {\n");
  out.push_str(alias);
  out.push_str("({");
  push_accessors(out, accessors);
  out.push_str("\n});\n} catch (__wel_err) {\n");
  out.push_str(
    "const __wel_s = typeof process === \"undefined\" ? \"\" : process.env.WRAP_ESM_LAMBDA_STRICT;\n",
  );
  out.push_str("if (__wel_s && __wel_s !== \"0\" && __wel_s !== \"false\") throw __wel_err;\n");
  out.push_str("console.error(");
  out.push_str(&quote_js_string(&format!(
    "wrap-esm-lambda: patch '{}' failed, continuing without it:",
    key
  )));
  out.push_str(", __wel_err);\n}\n");
}

/// Per-entry accessor snippet (the patch call), shared by both paths.
/// Import delivery (`registry = false`) is mode-specific: an ESM module gets
/// a static `import`, a CJS module a `require()` in an IIFE — an `import`
/// statement appended to CJS source would flip the module's format under
/// every bundler's syntax detection and break its `module.exports`.
pub(crate) fn build_snippet(
  accessors: &[Accessor],
  patch_name: &str,
  patch_from: &str,
  registry: bool,
  alias_index: u32,
  cjs: bool,
) -> String {
  let mut out = String::with_capacity(512);
  if registry {
    let key = format!("{}#{}", patch_from, patch_name);
    out.push_str("\n;(() => {\nconst __wel_registry = globalThis[Symbol.for(\"wrap-esm-lambda.patches\")];\nconst __wel_patch = __wel_registry && __wel_registry[");
    out.push_str(&quote_js_string(&key));
    out.push_str("];\nif (__wel_patch) __wel_patch({");
    push_accessors(&mut out, accessors);
    out.push_str("\n});\n})();\n");
  } else if cjs {
    let alias = format!("__wel_patch_{}", alias_index);
    out.push_str("\n;(() => {\nconst { ");
    out.push_str(patch_name);
    out.push_str(": ");
    out.push_str(&alias);
    out.push_str(" } = require(");
    out.push_str(&quote_js_string(patch_from));
    out.push_str(");\n");
    push_guarded_call(
      &mut out,
      &alias,
      &format!("{}#{}", patch_from, patch_name),
      accessors,
    );
    out.push_str("})();\n");
  } else {
    let alias = format!("__wel_patch_{}", alias_index);
    out.push_str("\nimport { ");
    out.push_str(patch_name);
    out.push_str(" as ");
    out.push_str(&alias);
    out.push_str(" } from ");
    out.push_str(&quote_js_string(patch_from));
    out.push_str(";\n");
    push_guarded_call(
      &mut out,
      &alias,
      &format!("{}#{}", patch_from, patch_name),
      accessors,
    );
  }
  out
}
