'use strict'
const { greet, strict, hoisted } = require('@fake/early-return')

console.log(`${greet('x')} strict:${strict} hoisted:${hoisted}`)
