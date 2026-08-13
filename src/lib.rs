#![deny(clippy::all)]

mod transform;

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::path::Path;

/// The version of the transform contract this addon implements: the emitted
/// snippet shapes plus the `TapEntryInput` / `TapResult` surfaces core depends
/// on. Bumped whenever one of those changes in a way core has to match.
///
/// Core's package range cannot express this on its own. The addon is an
/// optional dependency resolved on the consumer's machine, so a core that was
/// installed with one addon can end up loaded next to another — and a silently
/// mismatched tap emits code that looks right and patches nothing. Core asks
/// for this number at bind time and treats a mismatch the same way it treats
/// an addon that will not load at all.
#[napi]
pub fn tap_contract_version() -> u32 {
  3
}

/// One patch entry's inputs to the exports tap — mirrors the JS config entry.
/// `aliasIndex` keeps the injected import alias unique when several entries
/// patch the same module in import delivery. `privates` maps a class name to
/// the private names whose get/set bridge the class body should publish
/// under `Symbol.for("wrap-esm-lambda.privates")` — the class-body injection
/// of docs/design-private-bindings.md. (An `IndexMap` so the emission
/// follows the JS object's insertion order; determinism is part of the
/// emission contract.)
#[napi(object)]
pub struct TapEntryInput {
  pub bindings: Vec<String>,
  pub patch_name: String,
  pub patch_from: String,
  pub alias_index: u32,
  pub privates: Option<indexmap::IndexMap<String, Vec<String>>>,
}

/// Result of `exportsTap` for one module (all entries at once):
/// - `code == null` — the append-only fast path: every requested binding was
///   already a reassignable local. Append `snippets` after the untouched
///   source (a byte-buffer caller never decodes it).
/// - `code != null` — the module needed restructuring (a `const` export, an
///   anonymous default, a re-export or import-backed list export) and was
///   regenerated from its AST; `map` is the v3 source map of that rewrite
///   (already chained through `upstreamMap` when one was given). Append
///   `snippets` after `code`.
#[napi(object)]
pub struct TapResult {
  pub snippets: String,
  pub code: Option<String>,
  pub map: Option<String>,
}

/// A resolution for a name forwarded by a bare `export * from`: `binding`
/// is (transitively) provided by the star source `source`. Produced by the
/// caller's star-graph walk over `esmModuleExports`; the tap then reroutes
/// the name through an append-only shadow export (explicit named exports
/// shadow `export *` for the same name — no rewrite needed).
#[napi(object)]
pub struct TapStarResolution {
  pub binding: String,
  pub source: String,
}

/// One re-exported name with its provenance: `exported` is the name this
/// module's consumers see, `imported` the name taken from `source` (`*`
/// for a namespace re-export, `default` for a default import). Covers
/// explicit re-exports (`export { a as b } from "m"`), namespace
/// re-exports (`export * as ns from "m"`) and list exports of
/// import-backed locals (`import { x } from "m"; export { x }`) — the
/// shapes whose binding lives in another module, which is what lets the
/// star walk compare providers by resolved origin the way ECMA
/// ResolveExport does (two `export *` sources forwarding the SAME origin
/// binding are not ambiguous; date-fns ships exactly that shape).
#[napi(object)]
pub struct EsmReexport {
  pub exported: String,
  pub imported: String,
  pub source: String,
}

/// The statically visible surface of an ESM module: every exported name
/// (including `default` and `export * as ns` names), the specifiers of
/// bare `export * from` statements, plus the provenance of every export
/// that resolves into another module (`reexports`). The building block for
/// resolving star-forwarded names: walk the star sources' files with this,
/// compare providers by transitive origin, then pass the found provenance
/// to `exportsTap` as `starResolutions`.
#[napi(object)]
pub struct EsmExportsInfo {
  pub names: Vec<String>,
  pub star_sources: Vec<String>,
  pub reexports: Vec<EsmReexport>,
}

#[napi]
pub fn resolve_module(specifier: String, from_dir: String) -> Option<String> {
  transform::resolve_module(&specifier, Path::new(&from_dir))
    .map(|path| path.to_string_lossy().into_owned())
}

/// Resolve all requested names behind a module's bare star exports in one
/// native call. File reads, parsing, resolution and graph traversal remain in
/// Rust instead of crossing napi once per source file.
#[napi]
pub fn resolve_star_bindings(
  missing: Vec<String>,
  star_sources: Vec<String>,
  module_path: String,
) -> napi::Result<Vec<TapStarResolution>> {
  transform::resolve_star_bindings(&missing, &star_sources, Path::new(&module_path))
    .map(star_resolutions_out)
    .map_err(napi::Error::from_reason)
}

/// Whether the source contains ESM module syntax (`import`/`export`
/// statements or `import.meta`) — the question Node's own format detection
/// answers for a `.js` file with no `"type"` field, and the fallback core's
/// CJS-or-ESM decision uses at build time when no explicit format is
/// available. A source that does not parse as ESM reports `false`.
#[napi]
pub fn has_module_syntax(input: String) -> bool {
  transform::has_module_syntax(&input)
}

#[napi]
pub fn esm_module_exports(input: String) -> EsmExportsInfo {
  exports_info_out(transform::esm_module_exports(&input))
}

#[napi]
pub fn esm_module_exports_for_file(input: String, filename: String) -> EsmExportsInfo {
  exports_info_out(transform::esm_module_exports_for_file(
    &input,
    Path::new(&filename),
  ))
}

fn exports_info_out(
  (names, star_sources, reexports): (Vec<String>, Vec<String>, Vec<transform::ReexportInfo>),
) -> EsmExportsInfo {
  EsmExportsInfo {
    names,
    star_sources,
    reexports: reexports
      .into_iter()
      .map(|info| EsmReexport {
        exported: info.exported,
        imported: info.imported,
        source: info.source,
      })
      .collect(),
  }
}

fn star_resolutions_in(
  resolutions: Option<Vec<TapStarResolution>>,
) -> Vec<transform::StarResolution> {
  resolutions
    .unwrap_or_default()
    .into_iter()
    .map(|resolution| transform::StarResolution {
      binding: resolution.binding,
      source: resolution.source,
    })
    .collect()
}

fn star_resolutions_out(resolutions: Vec<transform::StarResolution>) -> Vec<TapStarResolution> {
  resolutions
    .into_iter()
    .map(|resolution| TapStarResolution {
      binding: resolution.binding,
      source: resolution.source,
    })
    .collect()
}

fn tap_entries(entries: Vec<TapEntryInput>) -> Vec<transform::TapEntry> {
  entries
    .into_iter()
    .map(|entry| transform::TapEntry {
      bindings: entry.bindings,
      patch_name: entry.patch_name,
      patch_from: entry.patch_from,
      alias_index: entry.alias_index,
      privates: entry.privates,
    })
    .collect()
}

/// The shared body of `exports_tap` and `exports_tap_from_buffer`: convert
/// the napi input shapes, run the tap, wrap the outcome. The two entry
/// points differ only in how the module source arrives.
fn run_exports_tap(
  source: &str,
  entries: Vec<TapEntryInput>,
  cjs: bool,
  registry: bool,
  filename: Option<String>,
  upstream_map: Option<String>,
  star_resolutions: Option<Vec<TapStarResolution>>,
) -> napi::Result<TapResult> {
  let out = transform::exports_tap(
    source,
    &tap_entries(entries),
    cjs,
    registry,
    filename.as_deref(),
    upstream_map.as_deref(),
    &star_resolutions_in(star_resolutions),
  )
  .map_err(napi::Error::from_reason)?;
  Ok(TapResult {
    snippets: out.snippets,
    code: out.code,
    map: out.map,
  })
}

/// The generic "exports tap" behind declarative patches, for every patch
/// entry of one module in a single call (one parse, at most one codegen):
/// each entry's patch function is handed the module's live bindings as
/// get/set accessors. The module is parsed once and every requested name
/// validated against its statically visible exports — a missing export
/// throws (the version-drift alarm). Bindings that are already reassignable
/// locals cost only the appended snippet; bindings that need restructuring
/// (`export const`, anonymous `export default`, re-exports, import-backed
/// locals) trigger an AST rewrite and `code`/`map` come back non-null. In
/// CJS mode (`cjs = true`) accessors go through `module.exports`, no
/// validation or rewrite happens and `input` is ignored — pass an empty
/// string. `registry` picks patch delivery: false emits a static import of
/// each entry's `patchFrom` (build time); true looks patches up in the
/// `Symbol.for("wrap-esm-lambda.patches")` global registry the runtime
/// shell preloads (no injected import/require at all). `filename` names the
/// module in the rewrite source map; `upstreamMap` chains an
/// already-applied transform's map through the rewrite.
#[napi]
pub fn exports_tap(
  input: String,
  entries: Vec<TapEntryInput>,
  cjs: bool,
  registry: bool,
  filename: Option<String>,
  upstream_map: Option<String>,
  star_resolutions: Option<Vec<TapStarResolution>>,
) -> napi::Result<TapResult> {
  run_exports_tap(
    &input,
    entries,
    cjs,
    registry,
    filename,
    upstream_map,
    star_resolutions,
  )
}

/// Buffer-input variant of `exportsTap`, for the runtime hook path where
/// `registerHooks`' `nextLoad` already provides the source as UTF-8 bytes:
/// the Buffer crosses napi zero-copy, so validating a module's exports never
/// converts the whole source UTF-16 -> UTF-8. On the fast path (`code ==
/// null`) the source is never decoded at all — the caller appends `snippets`
/// bytes to the original buffer. On the rewrite path the regenerated module
/// comes back as a string (Node compiles from UTF-16 either way, so a string
/// costs the same single conversion). In CJS mode `input` is ignored — pass
/// an empty buffer. Throws if `input` is not valid UTF-8.
#[napi]
pub fn exports_tap_from_buffer(
  input: Buffer,
  entries: Vec<TapEntryInput>,
  cjs: bool,
  registry: bool,
  filename: Option<String>,
  upstream_map: Option<String>,
  star_resolutions: Option<Vec<TapStarResolution>>,
) -> napi::Result<TapResult> {
  let source = if cjs {
    ""
  } else {
    std::str::from_utf8(&input)
      .map_err(|err| napi::Error::from_reason(format!("module source is not valid UTF-8: {err}")))?
  };
  run_exports_tap(
    source,
    entries,
    cjs,
    registry,
    filename,
    upstream_map,
    star_resolutions,
  )
}
