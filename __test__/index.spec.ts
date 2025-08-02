import test from 'ava'

import { transformLambda } from '../index'

// export variants: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/export

test('variable export', (t) => {
  const input = `export const handler = async function(event) {
	return "Hi from AWS Lambda";
}`;
  const expected = `const orig_handler = async function(event) {
	return "Hi from AWS Lambda";
};
export const handler = WrapAwsLambda(orig_handler);
`;
  const output = transformLambda(input, 'handler', 'WrapAwsLambda');
  t.deepEqual(output, expected);
});

test('function export', (t) => {
  const input = `export async function handler(event) {
	return "Hi from AWS Lambda";
}`;
  const expected = `const orig_handler = async function(event) {
	return "Hi from AWS Lambda";
};
export const handler = WrapAwsLambda(orig_handler);
`;
  const output = transformLambda(input, 'handler', 'WrapAwsLambda');
  t.deepEqual(output, expected);
});

test('export renames', (t) => {
  const input = `
  const x = 1;
  const y = async (event) => "Hi from AWS Lambda";
  export { x, y as z };
`
const expected = `const x = 1;
const orig_y = async (event) => "Hi from AWS Lambda";
const y = WrapAwsLambda(orig_y);
export { x, y as z };
`;
  const output = transformLambda(input, 'z', 'WrapAwsLambda');
  t.deepEqual(output, expected);
});
