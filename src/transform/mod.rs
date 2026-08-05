//! The exports tap, split along its phases:
//!
//! - [`export_index`] — one static pass indexing a module's exports;
//! - [`rewrite`] — resolving requested bindings against that index and
//!   restructuring the AST when a binding is not already reassignable;
//! - [`snippet`] — the emitted JS text (accessors, guarded patch calls,
//!   star stubs);
//! - [`source_map`] — chaining the rewrite's map through an upstream map.
//!
//! This file holds the public surface `lib.rs` re-exports over napi:
//! [`exports_tap`], [`has_module_syntax`] and [`esm_module_exports`], plus
//! their input/output types.

mod export_index;
mod rewrite;
mod snippet;
mod source_map;

use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_sourcemap::SourceMap;
use oxc_span::SourceType;

use export_index::{NamedKind, build_export_index};
use rewrite::{FreshNames, RewriteOps, apply_rewrites, resolve_binding};
use snippet::{build_snippet, push_star_stub};
use source_map::chain_source_maps;

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

/// One re-exported name with its provenance, as `esm_module_exports`
/// reports it: `exported` reaches this module's consumers, `imported` is
/// the name taken from `source` (`*` for a namespace re-export). The
/// building block for the caller's same-binding comparison of star
/// providers (ECMA ResolveExport dedupes identical resolutions; a walk that
/// only counts providers cannot).
pub struct ReexportInfo {
  pub exported: String,
  pub imported: String,
  pub source: String,
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
        true,
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
      false,
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

/// Does the source contain ESM module syntax — `import`/`export` statements
/// or `import.meta`? This is the same question Node's own format detection
/// and every bundler's syntax sniffing answer for an extensionless-ambiguous
/// `.js` file, and core's CJS-or-ESM fallback at build time keys on it. A
/// source that fails to parse as ESM reports `false`: whatever it is, the
/// ESM tap cannot read it, and CJS is the only tap that could still apply.
pub fn has_module_syntax(source_text: &str) -> bool {
  let allocator = Allocator::default();
  let parsed = Parser::new(&allocator, source_text, SourceType::mjs()).parse();
  if parsed.panicked || !parsed.diagnostics.is_empty() {
    return false;
  }
  parsed.module_record.has_module_syntax
}

/// The statically visible surface of an ESM module, for the caller's
/// star-graph walk: every exported name (including `default` and
/// `export * as ns` names) plus the specifiers of bare `export * from`
/// statements, whose forwarded names require reading those sources.
pub fn esm_module_exports(source_text: &str) -> (Vec<String>, Vec<String>, Vec<ReexportInfo>) {
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
  // provenance of every export that resolves into another module, so the
  // caller's star walk can compare origins the way ResolveExport does:
  // explicit re-exports, namespace re-exports, and list exports of
  // import-backed locals (`import { x } from "m"; export { x }` — the
  // binding is m's, exactly as if written `export { x } from "m"`)
  let reexports: Vec<ReexportInfo> = index
    .named
    .iter()
    .filter_map(|info| match info.kind {
      NamedKind::ReExport => Some(ReexportInfo {
        exported: info.exported.clone(),
        imported: info.local.clone(),
        source: info
          .source
          .clone()
          .expect("ReExport always carries a source"),
      }),
      NamedKind::ReExportAll => Some(ReexportInfo {
        exported: info.exported.clone(),
        imported: "*".to_string(),
        source: info
          .source
          .clone()
          .expect("ReExportAll always carries a source"),
      }),
      NamedKind::ListLocal => index
        .import_locals
        .get(&info.local)
        .map(|origin| ReexportInfo {
          exported: info.exported.clone(),
          imported: origin.imported.clone(),
          source: origin.source.clone(),
        }),
      _ => None,
    })
    .collect();
  (names, index.star_sources, reexports)
}

#[cfg(test)]
mod tests;
