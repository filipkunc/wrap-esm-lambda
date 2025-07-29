import test from 'ava'

import { transformLambda } from '../index'

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
