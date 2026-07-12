import { Bench } from 'tinybench'

import { transformLambda as transformBabel } from './babel-transform.js'
import { transformLambda as transformOxc } from '../index.js'
// @ts-expect-error next-line
import { transformLambda as transformSwc } from '../hooks/swc-wrapper.cjs'
import { transformLambda as transformAcorn } from './acorn-transform.js'
import { transformLambda as transformRegex } from './regex-transform.js'
import {
  transformLambdaTracing as transformOrchestrionTracing,
  transformLambdaMinimal as transformOrchestrionMinimal,
  transformLambdaMinimalCached as transformOrchestrionMinimalCached,
} from './orchestrion-transform.js'
import { transformOxcInlineMap, transformOxcChainedToTs } from './oxc-sourcemap.js'

const b = new Bench()

const testInput = `export const handler = async function(event) {
	return "Hi from AWS Lambda";
}`

b.add('Babel', () => {
  transformBabel(testInput, 'handler', 'wrapper')
})

b.add('oxc.rs', () => {
  transformOxc(testInput, 'handler', 'wrapper')
})

b.add('oxc.rs + source map', () => {
  transformOxcInlineMap(testInput)
})

b.add('oxc.rs + map chained to .ts', () => {
  transformOxcChainedToTs()
})

b.add('swc.rs', () => {
  transformSwc(testInput, 'handler', 'wrapper')
})

b.add('acorn', () => {
  transformAcorn(testInput, 'handler', 'wrapper')
})

b.add('regex', () => {
  transformRegex(testInput, 'handler', 'wrapper')
})

b.add('orchestrion (minimal wrap)', () => {
  transformOrchestrionMinimal(testInput)
})

b.add('orchestrion (minimal wrap, cached selector)', () => {
  transformOrchestrionMinimalCached(testInput)
})

b.add('orchestrion (tracing)', () => {
  transformOrchestrionTracing(testInput)
})

await b.run()

console.table(b.table())
