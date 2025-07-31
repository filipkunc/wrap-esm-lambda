import { Bench } from 'tinybench'

import { transformLambda as transformBabel } from './babel-transform.js';
import { transformLambda as transformOxc } from '../index.js'

function transformReplace(input: string, handler: string, wrapper: string): string {
  const exportNamedDecl = `export const ${handler}`;
  const origHandler = `orig_${handler}`;
    if (input.includes(exportNamedDecl)) {
        let transformed = input.replace(exportNamedDecl, `const ${origHandler}`);
        transformed += `\n${exportNamedDecl} = ${wrapper}(${origHandler});`;
        return transformed;
    }
    return input;
}

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
