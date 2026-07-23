// Consumes each shape the way an ordinary app would — named import of the
// const, default import, named import through the barrel.
import { handler } from '@fake/shapes/const.js'
import dflt from '@fake/shapes/default.js'
import { Inner } from '@fake/shapes/barrel.js'

console.log(`${await handler('x')} ${await dflt('y')} ${new Inner().greet()}`)
