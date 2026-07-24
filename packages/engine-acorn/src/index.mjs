// Pure-JavaScript engine for wrap-esm-lambda: the same API surface as the
// native oxc addon (see index.d.ts at the repo root for the contract docs),
// implemented on acorn (parse) + magic-string (edit + map) +
// @jridgewell/remapping (map chaining). Core selects between the two engines
// via WRAP_ESM_LAMBDA_ENGINE — see packages/core/src/engine.mjs.
//
// The module layout mirrors the native side:
// - exports-index.mjs — one-pass export surface index (build_export_index)
// - snippets.mjs      — byte-identical emitted-text builders
// - tap.mjs           — the exports tap (fast path + magic-string rewrites)
// - wrap.mjs          — the original handler-wrap transform
// - sourcemaps.mjs    — map chaining and data-URL inlining

export { esmModuleExports } from './exports-index.mjs'
export { exportsTap, exportsTapFromBuffer } from './tap.mjs'
export {
  transformLambda,
  transformLambdaFromBuffer,
  transformLambdaWithMap,
  transformLambdaWithMapObject,
  transformLambdaWithChainedMap,
  transformLambdaWithChainedMapObject,
} from './wrap.mjs'
