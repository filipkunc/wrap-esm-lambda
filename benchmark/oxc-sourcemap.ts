import { transformLambdaWithMap, transformLambdaWithMapObject } from '../index.js'
import { jsCode, chainToTs } from './ts-fixture.js'

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
