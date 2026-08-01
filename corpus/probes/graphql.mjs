// graphql probe: `parse` imported through the barrel must observe the rebind
// applied at its defining module — ESM live bindings propagate the wrap
// through the whole re-export chain.
import { parse } from 'graphql'

const doc = parse('{ hero { name } }')

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(doc.kind === 'Document' && count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count} kind=${doc.kind}`)
