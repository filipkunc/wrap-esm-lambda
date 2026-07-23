// Consumes each shape the way an ordinary app would — named import of the
// const, the same module again as a namespace (live binding through the
// rewrite), default import, the barrel, a destructured export, and a
// namespace re-export.
import { handler } from '@fake/shapes/const.js'
import * as constNs from '@fake/shapes/const.js'
import dflt from '@fake/shapes/default.js'
import { Inner } from '@fake/shapes/barrel.js'
import { greet } from '@fake/shapes/destructured.js'
import { inner } from '@fake/shapes/ns.js'

const parts = [
  await handler('x'),
  await constNs.handler('n'),
  await dflt('y'),
  new Inner().greet(),
  greet(),
  new inner.Inner().greet(),
]
console.log(parts.join(' '))
