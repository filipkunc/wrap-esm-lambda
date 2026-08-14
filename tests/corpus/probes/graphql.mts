// graphql probe: `parse` imported through the barrel must observe the rebind
// applied at its defining module — ESM live bindings propagate the wrap
// through the whole re-export chain.
import { parse } from 'graphql'
import { report } from '../lib/probe-count.mts'

const doc = parse('{ hero { name } }')

report(doc.kind === 'Document', `kind=${doc.kind}`)
