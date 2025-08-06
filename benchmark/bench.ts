import { Bench } from 'tinybench'

import { transformLambda as transformBabel } from './babel-transform.js';
import { transformLambda as transformOxc } from '../index.js';
// @ts-expect-error next-line
import { transformLambda as transformSwc } from '../hooks/swc-wrapper.cjs';
import { transformLambda as transformAcorn } from './acorn-transform.js';
import { transformLambda as transformRegex } from './regex-transform.js';

const b = new Bench();

const testInput = `export const handler = async function(event) {
	return "Hi from AWS Lambda";
}`;

b.add('Babel', () => {
  transformBabel(testInput, 'handler', 'wrapper');
});

b.add('oxc.rs', () => {
  transformOxc(testInput, 'handler', 'wrapper');
});

b.add('swc.rs', () => {
  transformSwc(testInput, 'handler', 'wrapper');
});

b.add('acorn', () => {
  transformAcorn(testInput, 'handler', 'wrapper');
});

b.add('regex', () => {
  transformRegex(testInput, 'handler', 'wrapper');
});

await b.run();

console.table(b.table());
