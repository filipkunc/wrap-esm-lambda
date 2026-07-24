// Source-map composition for the JS engine. The native engine chains maps
// inside Rust via oxc_sourcemap token lookup; here the same trace runs
// through @ampproject/remapping — the reference implementation of exactly
// that compose. Tokens the upstream map has no mapping for are dropped by
// both, so the two engines agree on chained-map semantics.
import remapping from '@ampproject/remapping'

/**
 * Compose `mapJson` (`transformed -> intermediate`, fresh from this engine)
 * with `upstreamJson` (`intermediate -> original`, e.g. tsc's `handler.js ->
 * handler.ts` map) so the result maps the transformed code straight to the
 * original sources.
 *
 * @param {string | object} mapJson
 * @param {string} upstreamJson
 * @returns {string} the chained v3 map as JSON
 */
export function chainMaps(mapJson, upstreamJson) {
  const chained = remapping([normalize(mapJson), normalize(upstreamJson)], () => null)
  return JSON.stringify(chained)
}

function normalize(map) {
  return typeof map === 'string' ? JSON.parse(map) : JSON.parse(JSON.stringify(map))
}

/** Inline a v3 map JSON as the data URL the native engine's `to_data_url` emits. */
export function mapToDataUrl(mapJson) {
  return `data:application/json;charset=utf-8;base64,${Buffer.from(mapJson, 'utf8').toString('base64')}`
}
