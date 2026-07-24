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
import { transformOxcInlineMap, transformOxcChainedToTs, transformOxcChainedToTsRust } from './oxc-sourcemap.js'
import { transformAcornInlineMap, transformAcornChainedToTs } from './acorn-sourcemap.js'
// @ts-expect-error untyped workspace package
import * as acornEngine from '@wrap-esm-lambda/engine-acorn'

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

b.add('oxc.rs + map chained in Rust', () => {
  transformOxcChainedToTsRust()
})

b.add('swc.rs', () => {
  transformSwc(testInput, 'handler', 'wrapper')
})

b.add('acorn', () => {
  transformAcorn(testInput, 'handler', 'wrapper')
})

b.add('acorn + source map', () => {
  transformAcornInlineMap(testInput, 'handler', 'wrapper', 'handler.mjs')
})

b.add('acorn + map chained to .ts', () => {
  transformAcornChainedToTs()
})

// the shipped JS engine (acorn + magic-string edits, no astring codegen)
b.add('acorn engine (magic-string)', () => {
  acornEngine.transformLambda(testInput, 'handler', 'wrapper')
})

b.add('acorn engine + source map', () => {
  acornEngine.transformLambdaWithMapObject(testInput, 'handler', 'wrapper', 'handler.mjs')
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
