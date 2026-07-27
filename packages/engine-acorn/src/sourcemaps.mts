// Source-map composition for the JS engine. The native engine chains maps
// inside Rust via oxc_sourcemap token lookup; here the same trace runs
// through @jridgewell/remapping (the maintained home of what used to be
// @ampproject/remapping) — the reference implementation of exactly that
// compose. Tokens the upstream map has no mapping for are dropped by both,
// so the two engines agree on chained-map semantics.
import remapping from '@jridgewell/remapping'
import type { EncodedSourceMap } from '@jridgewell/remapping'

/**
 * Compose `mapJson` (`transformed -> intermediate`, fresh from this engine)
 * with `upstreamJson` (`intermediate -> original`, e.g. tsc's `handler.js ->
 * handler.ts` map) so the result maps the transformed code straight to the
 * original sources.
 *
 * @returns the chained v3 map as JSON
 */
export function chainMaps(mapJson: string | object, upstreamJson: string): string {
  const chained = remapping([normalize(mapJson), normalize(upstreamJson)], () => null)
  return JSON.stringify(chained)
}

function normalize(map: string | object): EncodedSourceMap {
  return (typeof map === 'string' ? JSON.parse(map) : JSON.parse(JSON.stringify(map))) as EncodedSourceMap
}
