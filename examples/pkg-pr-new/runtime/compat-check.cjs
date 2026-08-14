'use strict'

const assert = require('node:assert/strict')

const legacy = require('wrap-esm-lambda')
const current = require('@wrap-esm-lambda/engine-oxc')

assert.strictEqual(legacy, current, 'the legacy package must forward the exact native-addon module object')
assert.deepStrictEqual(
  Object.keys(legacy).sort(),
  Object.keys(current).sort(),
  'the legacy and scoped package names must expose the same API',
)
assert.strictEqual(typeof current.exportsTap, 'function', 'the native exportsTap API must be present')

console.log('wrap-esm-lambda forwards the complete @wrap-esm-lambda/engine-oxc API')
