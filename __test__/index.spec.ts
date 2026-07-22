import test from 'ava'
import ts from 'typescript'

import {
  transformLambda,
  transformLambdaFromBuffer,
  transformLambdaWithMap,
  transformLambdaWithMapObject,
  transformLambdaWithChainedMap,
} from '../index'

// export variants: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/export

test('variable export', (t) => {
  const input = `export const handler = async function(event) {
	return "Hi from AWS Lambda";
}`
  const expected = `export const handler = WrapAwsLambda(async function(event) {
	return "Hi from AWS Lambda";
});
`
  const output = transformLambda(input, 'handler', 'WrapAwsLambda')
  t.deepEqual(output, expected)
})

test('buffer-input variant: identical to the string transform, UTF-8 in', (t) => {
  // What a registerHooks load hook holds: the UTF-8 bytes from nextLoad. The
  // non-ASCII payload proves the bytes cross napi as UTF-8, not re-encoded.
  const input = `export const handler = async (event) => {
	return "Ahoj světe 👋";
}`
  const output = transformLambdaFromBuffer(Buffer.from(input), 'handler', 'WrapAwsLambda')
  t.deepEqual(output, transformLambda(input, 'handler', 'WrapAwsLambda'))
})

test('buffer-input variant: invalid UTF-8 fails loudly', (t) => {
  const err = t.throws(() => transformLambdaFromBuffer(Buffer.from([0xff, 0xfe, 0x00]), 'handler', 'WrapAwsLambda'))
  t.regex(err!.message, /not valid UTF-8/)
})

test('function export', (t) => {
  const input = `export async function handler(event) {
	return "Hi from AWS Lambda";
}`
  const expected = `export const handler = WrapAwsLambda(async function(event) {
	return "Hi from AWS Lambda";
});
`
  const output = transformLambda(input, 'handler', 'WrapAwsLambda')
  t.deepEqual(output, expected)
})

test('export renames', (t) => {
  const input = `
  const x = 1;
  const y = async (event) => "Hi from AWS Lambda";
  export { x, y as z };
`
  const expected = `const x = 1;
const y = WrapAwsLambda(async (event) => "Hi from AWS Lambda");
export { x, y as z };
`
  const output = transformLambda(input, 'z', 'WrapAwsLambda')
  t.deepEqual(output, expected)
})

test('inline source map', (t) => {
  // Blank lines get stripped by codegen, so the throw moves from line 4 in the
  // source to line 2 in the output. The map must carry the original position.
  const input = `export const handler = async (event) => {


  throw new Error("boom");
};
`
  const output = transformLambdaWithMap(input, 'handler', 'WrapAwsLambda', 'handler.mjs')
  t.true(output.includes('WrapAwsLambda('))

  const match = output.match(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,(.+)/)
  t.truthy(match)
  const map = JSON.parse(Buffer.from(match![1], 'base64').toString('utf8'))
  t.is(map.version, 3)
  t.deepEqual(map.sources, ['handler.mjs'])
  t.deepEqual(map.sourcesContent, [input])
})

test('source map object for chaining', (t) => {
  // The object form returns the raw v3 map (no inline URL) so it can be composed
  // with an upstream .ts -> .js map. See hooks/sourcemap-ts-demo for the chain.
  const input = `export const handler = async (event) => {
  throw new Error("boom");
};
`
  const { code, map } = transformLambdaWithMapObject(input, 'handler', 'WrapAwsLambda', 'handler.js')
  t.true(code.includes('WrapAwsLambda('))
  t.false(code.includes('sourceMappingURL'))
  t.truthy(map)
  const parsed = JSON.parse(map!)
  t.is(parsed.version, 3)
  t.deepEqual(parsed.sources, ['handler.js'])
})

test('chained source map composed in Rust', (t) => {
  // The full tsc pipeline: transpile a .ts handler, then wrap the emitted .js
  // while chaining the wrap map through tsc's map — in one call, with the
  // compose done by oxc_sourcemap in Rust instead of @ampproject/remapping.
  const tsSource = `export const handler = async (event: { id?: number }): Promise<string> => {
  throw new Error(\`boom \${event?.id}\`);
};
`
  const tsOut = ts.transpileModule(tsSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
      inlineSources: true,
    },
    fileName: 'handler.ts',
  })
  const output = transformLambdaWithChainedMap(
    tsOut.outputText,
    'handler',
    'WrapAwsLambda',
    'handler.js',
    tsOut.sourceMapText!,
  )
  t.true(output.includes('WrapAwsLambda('))

  const match = output.match(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,(.+)/)
  t.truthy(match)
  const map = JSON.parse(Buffer.from(match![1], 'base64').toString('utf8'))
  t.is(map.version, 3)
  t.deepEqual(map.sources, ['handler.ts'])
  t.deepEqual(map.sourcesContent, [tsSource])
})
