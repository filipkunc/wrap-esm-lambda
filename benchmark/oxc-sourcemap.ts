import { transformLambdaWithMap, transformLambdaWithMapObject, transformLambdaWithChainedMapObject } from '../index.js'
import { jsCode, tscMap, chainToTs } from './ts-fixture.js'

// oxc emitting an inline source map for the wrapped handler.
export function transformOxcInlineMap(code: string): string {
  return transformLambdaWithMap(code, 'handler', 'wrapper', 'handler.mjs')
}

// oxc wrap + composing its map with tsc's map so the result reaches the .ts.
export function transformOxcChainedToTs(): string {
  const { code, map } = transformLambdaWithMapObject(jsCode, 'handler', 'wrapper', 'handler.js')
  if (!map) return code
  return chainToTs(map)
}

// Same wrap and chain, but the compose runs in Rust via oxc_sourcemap instead
// of @ampproject/remapping — the wrap map never round-trips through JSON, and
// the only JS<->Rust traffic is the tsc map in and the chained map out.
export function transformOxcChainedToTsRust(): string {
  const { code, map } = transformLambdaWithChainedMapObject(jsCode, 'handler', 'wrapper', 'handler.js', tscMap)
  return map ?? code
}
