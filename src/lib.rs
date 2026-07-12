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
