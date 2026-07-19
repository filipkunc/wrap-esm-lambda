#![deny(clippy::all)]

#[cfg_attr(all(target_arch = "x86_64", feature = "frida"), path = "detours.rs")]
#[cfg_attr(
  not(all(target_arch = "x86_64", feature = "frida")),
  path = "no-detours.rs"
)]
mod detours;

use detours::transform;
use napi_derive::napi;

#[napi]
pub fn transform_lambda(input: String, handler: String, wrapper: String) -> String {
  transform::transform_lambda_source(input, handler, wrapper)
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

/// The generic "exports tap" behind declarative patches: returns the snippet
/// the caller appends after the module source, calling a user-provided patch
/// function with the module's live bindings as get/set accessors. Only the
/// snippet crosses the napi boundary — round-tripping the whole source cost
/// two O(n) string conversions and dominated the latency. `input` is parsed
/// for export validation in ESM mode; in CJS mode (`cjs = true`) it is
/// ignored — pass an empty string. `registry` picks patch delivery: false
/// emits a static import of `patchFrom` (build time, aliased by
/// `aliasIndex`); true looks the patch up in the
/// `Symbol.for("wrap-esm-lambda.patches")` global registry the runtime shell
/// preloads (no injected import/require at all). Throws when a requested
/// export does not exist in an ESM module.
#[napi]
pub fn exports_tap_snippet(
  input: String,
  bindings: Vec<String>,
  patch_name: String,
  patch_from: String,
  cjs: bool,
  registry: bool,
  alias_index: u32,
) -> napi::Result<String> {
  transform::exports_tap_snippet(
    &input,
    bindings,
    &patch_name,
    &patch_from,
    cjs,
    registry,
    alias_index,
  )
  .map_err(napi::Error::from_reason)
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
