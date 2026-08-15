//! Source-map chaining for the rewrite path: composing the freshly generated
//! wrap map with whatever map the caller's earlier transform produced, so
//! the final map reaches the original source in one hop.

use oxc_sourcemap::{SourceMap, SourceMapBuilder};

/// Compose `wrap_map` (`transformed -> intermediate`, fresh from codegen) with
/// `upstream` (`intermediate -> original`, e.g. tsc's `handler.js ->
/// handler.ts` map): every wrap token's source position is traced through
/// `upstream`, so the result maps the transformed code straight to the
/// original. This is the same trace `@ampproject/remapping` performs in JS,
/// done here with `oxc_sourcemap` token lookup instead — and since the wrap
/// map never leaves Rust, it also skips a JSON serialize/re-parse round-trip.
/// Tokens `upstream` has no mapping for are dropped, matching `remapping`.
pub(crate) fn chain_source_maps<'a>(
  wrap_map: &'a SourceMap,
  upstream: &'a SourceMap,
) -> SourceMap<'a> {
  let lookup_table = upstream.generate_lookup_table();
  let mut builder = SourceMapBuilder::default();
  if let Some(file) = wrap_map.get_file() {
    builder.set_file(file);
  }
  for token in wrap_map.get_tokens() {
    let original = upstream.lookup_source_view_token_approx(
      &lookup_table,
      token.get_src_line(),
      token.get_src_col(),
    );
    let Some(original) = original else { continue };
    let Some(source) = original.get_source() else {
      continue;
    };
    let src_id =
      builder.add_source_and_content(source, original.get_source_content().unwrap_or(""));
    let name = original
      .get_name()
      .or_else(|| token.get_name_id().and_then(|id| wrap_map.get_name(id)));
    let name_id = name.map(|name| builder.add_name(name));
    builder.add_token(
      token.get_dst_line(),
      token.get_dst_col(),
      original.get_src_line(),
      original.get_src_col(),
      Some(src_id),
      name_id,
    );
  }
  builder.into_sourcemap()
}
