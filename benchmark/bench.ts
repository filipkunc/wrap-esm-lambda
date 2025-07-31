import { Bench } from 'tinybench'

import { transformLambda as transformBabel } from './babel-transform.js';
import { transformLambda as transformOxc } from '../index.js'
import { transformLambda as transformReplace } from './replace-transform.js';

const b = new Bench()

const testInput = `export const handler = async function(event) {
	return "Hi from AWS Lambda";
}`;

b.add('Babel', () => {
  transformBabel(testInput, 'handler', 'wrapper');
})

b.add('oxc.rs', () => {
  transformOxc(testInput, 'handler', 'wrapper');
})

b.add('String replace', () => {
  transformReplace(testInput, 'handler', 'wrapper');
})

await b.run()

console.table(b.table());
