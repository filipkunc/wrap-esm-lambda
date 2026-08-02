// ESM consumer cell: import the corpus package, report what a consumer
// observes. Run twice — once bare (control), once under the runtime hook
// with the generated identity config — and diff the reports.
import { fingerprint } from './fingerprint.mts'

const pkg = process.env.CORPUS_PKG
if (!pkg) throw new Error('CORPUS_PKG not set')

const ns: unknown = await import(pkg)
const runs =
  ((globalThis as Record<symbol, unknown>)[Symbol.for('wrap-esm-lambda-corpus.runs')] as number | undefined) ?? 0
console.log(JSON.stringify({ runs, fingerprint: fingerprint(ns) }))
