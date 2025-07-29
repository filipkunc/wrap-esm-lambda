#![deny(clippy::all)]

use napi_derive::napi;
mod transform;

#[napi]
pub fn transform_lambda(input: String) -> String {
  transform::transform_lambda_source(input)
}
