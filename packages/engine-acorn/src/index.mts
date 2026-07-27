// Pure-JavaScript engine for wrap-esm-lambda: the tap contract the native
// oxc addon also implements (`TransformEngine` in core's engine.mts),
// implemented on acorn (parse) + magic-string (edit + map) +
// @jridgewell/remapping (map chaining). Core selects between the two engines
// via WRAP_ESM_LAMBDA_ENGINE — see packages/core/src/engine.mjs. The
// addon's standalone `transformLambda*` exports have no twin here: they sit
// outside the contract, kept native-side as the benchmark comparison
// subject.
//
// The module layout mirrors the native side:
// - exports-index.mjs — one-pass export surface index (build_export_index)
// - snippets.mjs      — byte-identical emitted-text builders
// - tap.mjs           — the exports tap (fast path + magic-string rewrites)
// - sourcemaps.mjs    — map chaining and data-URL inlining
// - resolve.mjs       — import-style module resolution (oxc_resolver's twin)

/**
 * The transform contract this engine implements — the same number the native
 * addon reports from `tapContractVersion()`. Core compares them at bind time,
 * so the two implementations cannot drift apart across published versions.
 */
export function tapContractVersion(): number {
  return 2
}

export { esmModuleExports, hasModuleSyntax } from './exports-index.mjs'
export { exportsTap, exportsTapFromBuffer } from './tap.mjs'
export { resolveModule } from './resolve.mjs'
