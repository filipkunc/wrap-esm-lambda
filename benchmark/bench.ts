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

//console.table(b.table());

let mdTableContent = "| Task             | Latency avg (ns) | Throughput avg (ops/sec) |\n";
mdTableContent    += "|------------------|-----------------:|-------------------------:|\n";

b.tasks.forEach(task => {
  const latency = Math.round(task.result?.latency.mean! * 1e6);
  const opsPerSec = Math.round(task.result?.throughput.mean!);
  mdTableContent += `| ${task.name.padEnd(16)} | ${latency.toString().padStart(16)} | ${opsPerSec.toString().padStart(24)} |\n`;
});

console.log(mdTableContent);
