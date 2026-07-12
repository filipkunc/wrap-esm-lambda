import ts from 'typescript'
import { createRequire } from 'node:module'
import { transformLambdaWithMap, transformLambdaWithMapObject } from '../index.js'

// `@ampproject/remapping` is a CJS default-export function; requiring it avoids
// the ESM-interop typing friction of a default import under NodeNext.
type Remapping = (map: string, loader: (file: string) => string | null) => { toString(): string }
const remapping = createRequire(import.meta.url)('@ampproject/remapping') as Remapping

// oxc emitting an inline source map for the wrapped handler.
export function transformOxcInlineMap(code: string): string {
  return transformLambdaWithMap(code, 'handler', 'wrapper', 'handler.mjs')
}

// A representative TypeScript handler, transpiled once so the chained bar can
// measure the full `.ts` -> `.js` -> wrapped pipeline without touching disk.
const tsSource = `export const handler = async (event: { id?: number }): Promise<string> => {
  const detail = { id: event?.id ?? 42 }
  throw new Error(\`boom \${detail.id}\`)
}
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
const jsCode = tsOut.outputText
const tscMap = tsOut.sourceMapText!

// oxc wrap + composing its map with tsc's map so the result reaches the .ts.
export function transformOxcChainedToTs(): string {
  const { code, map } = transformLambdaWithMapObject(jsCode, 'handler', 'wrapper', 'handler.js')
  if (!map) return code
  return remapping(map, (file: string) => (file.endsWith('handler.js') ? tscMap : null)).toString()
}
