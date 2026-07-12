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
