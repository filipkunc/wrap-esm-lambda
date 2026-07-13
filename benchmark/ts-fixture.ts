import ts from 'typescript'
import { createRequire } from 'node:module'

// `@ampproject/remapping` is a CJS default-export function; requiring it avoids
// the ESM-interop typing friction of a default import under NodeNext.
type Remapping = (map: string, loader: (file: string) => string | null) => { toString(): string }
const remapping = createRequire(import.meta.url)('@ampproject/remapping') as Remapping

// A representative TypeScript handler, transpiled once so the chained bars can
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

/** The JS `tsc` emits for the handler above (input to the wrap step). */
export const jsCode = tsOut.outputText
/** tsc's `handler.js` -> `handler.ts` map. */
export const tscMap = tsOut.sourceMapText!

/**
 * Compose a `transformed -> handler.js` map with tsc's `handler.js -> handler.ts`
 * map so the result reaches the original TypeScript. Parser-independent: the same
 * step both the oxc and acorn chained bars run.
 */
export function chainToTs(mapJson: string): string {
  return remapping(mapJson, (file: string) => (file.endsWith('handler.js') ? tscMap : null)).toString()
}
