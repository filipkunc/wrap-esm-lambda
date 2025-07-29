import test from 'ava'

import { transformLambda } from '../index'

test('lambda is transformed correctly', (t) => {
  const input = `export const handler = async function(event) {
	return "Hi from AWS Lambda";
}`;
  const expected = `const orig_handler = async function(event) {
	return "Hi from AWS Lambda";
};
export const handler = WrapAwsLambda(orig_handler);
`;
  const output = transformLambda(input, 'handler', 'WrapAwsLambda');
  console.log(output);
  t.deepEqual(output, expected);
});
