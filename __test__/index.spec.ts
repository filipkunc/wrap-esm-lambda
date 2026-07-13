import test from 'ava'

import { transformLambda, transformLambdaWithMap, transformLambdaWithMapObject } from '../index'

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

test('native .ts source map, no tsc or chaining needed', (t) => {
  // A .ts filename tells oxc to parse and strip the types itself, so the map
  // already reaches the original .ts with no upstream map to compose.
  const input = `export const handler = async (event: { id?: number }): Promise<string> => {
  throw new Error(\`boom \${event?.id}\`);
};
`
  const output = transformLambdaWithMap(input, 'handler', 'WrapAwsLambda', 'handler.ts')
  t.true(output.includes('WrapAwsLambda('))
  t.false(output.includes(': {'), 'type annotations should be stripped')

  const match = output.match(/\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,(.+)/)
  t.truthy(match)
  const map = JSON.parse(Buffer.from(match![1], 'base64').toString('utf8'))
  t.is(map.version, 3)
  t.deepEqual(map.sources, ['handler.ts'])
  t.deepEqual(map.sourcesContent, [input])
})
