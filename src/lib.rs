#![deny(clippy::all)]

mod transform;

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi]
pub fn transform_lambda(input: String, handler: String, wrapper: String) -> String {
  transform::transform_lambda_source(&input, handler, wrapper)
}

/// Buffer-input variant of `transformLambda` for `registerHooks` load hooks:
/// `nextLoad` already delivers the module source as UTF-8 bytes, so a Buffer
/// argument crosses napi zero-copy and oxc parses the UTF-8 directly —
/// skipping both the `source.toString()` decode the hook would need and the
/// O(n) UTF-16 -> UTF-8 conversion of a napi string argument. The output
/// stays a string on purpose: Node compiles from a UTF-16 string either way,
/// so returning one costs the same single conversion while an external
/// napi buffer would add a fixed ~3 µs of creation overhead and leave the
/// decode to Node. Throws if `input` is not valid UTF-8.
#[napi]
pub fn transform_lambda_from_buffer(
  input: Buffer,
  handler: String,
  wrapper: String,
) -> napi::Result<String> {
  let source = std::str::from_utf8(&input)
    .map_err(|err| napi::Error::from_reason(format!("module source is not valid UTF-8: {err}")))?;
  Ok(transform::transform_lambda_source(source, handler, wrapper))
}

#[napi]
pub fn transform_lambda_with_map(
  input: String,
  handler: String,
  wrapper: String,
  filename: String,
) -> String {
  transform::transform_lambda_source_with_map(input, handler, wrapper, filename)
}

#[napi(object)]
pub struct TransformResult {
  pub code: String,
  pub map: Option<String>,
}

/// Returns the transformed code and the raw v3 source map JSON separately, so a
/// caller can compose the map with an upstream `.ts` -> `.js` map (e.g. from
/// `tsc`) before attaching it.
#[napi]
pub fn transform_lambda_with_map_object(
  input: String,
  handler: String,
  wrapper: String,
  filename: String,
) -> TransformResult {
  let (code, map) =
    transform::transform_lambda_source_with_map_json(input, handler, wrapper, filename);
  TransformResult { code, map }
}

/// Like `transformLambdaWithMap`, but chains the wrap map through
/// `upstreamMap` (the `filename -> original` map, e.g. tsc's `handler.js ->
/// handler.ts` map) inside Rust via `oxc_sourcemap`, so the inlined map
/// already reaches the original source — no `@ampproject/remapping` needed.
#[napi]
pub fn transform_lambda_with_chained_map(
  input: String,
  handler: String,
  wrapper: String,
  filename: String,
  upstream_map: String,
) -> String {
  transform::transform_lambda_source_with_chained_map(
    input,
    handler,
    wrapper,
    filename,
    upstream_map,
  )
}

/// One patch entry's inputs to the exports tap — mirrors the JS config entry.
/// `aliasIndex` keeps the injected import alias unique when several entries
/// patch the same module in import delivery.
#[napi(object)]
pub struct TapEntryInput {
  pub bindings: Vec<String>,
  pub patch_name: String,
  pub patch_from: String,
  pub alias_index: u32,
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

/// The statically visible surface of an ESM module: every exported name
/// (including `default` and `export * as ns` names) plus the specifiers of
/// bare `export * from` statements. The building block for resolving
/// star-forwarded names: walk the star sources' files with this, then pass
/// the found provenance to `exportsTap` as `starResolutions`.
#[napi(object)]
pub struct EsmExportsInfo {
  pub names: Vec<String>,
  pub star_sources: Vec<String>,
}

#[napi]
pub fn esm_module_exports(input: String) -> EsmExportsInfo {
  let (names, star_sources) = transform::esm_module_exports(&input);
  EsmExportsInfo {
    names,
    star_sources,
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

fn tap_entries(entries: Vec<TapEntryInput>) -> Vec<transform::TapEntry> {
  entries
    .into_iter()
    .map(|entry| transform::TapEntry {
      bindings: entry.bindings,
      patch_name: entry.patch_name,
      patch_from: entry.patch_from,
      alias_index: entry.alias_index,
    })
    .collect()
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
  let out = transform::exports_tap(
    &input,
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

/// Like `transformLambdaWithChainedMap`, but returns the code and the chained
/// v3 map JSON separately (no inline URL appended).
#[napi]
pub fn transform_lambda_with_chained_map_object(
  input: String,
  handler: String,
  wrapper: String,
  filename: String,
  upstream_map: String,
) -> TransformResult {
  let (code, map) = transform::transform_lambda_source_with_chained_map_json(
    input,
    handler,
    wrapper,
    filename,
    upstream_map,
  );
  TransformResult { code, map }
}
