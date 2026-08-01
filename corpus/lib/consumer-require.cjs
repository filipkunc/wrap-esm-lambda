// CJS consumer cell: require() the corpus package — for pure-ESM packages
// this exercises require(esm). Same report shape as the import consumer.
'use strict'
const { fingerprint } = require('./fingerprint.cjs')

const pkg = process.env.CORPUS_PKG
if (!pkg) throw new Error('CORPUS_PKG not set')

const exportsObject = require(pkg)
const runs = globalThis[Symbol.for('wrap-esm-lambda-corpus.runs')] ?? 0
console.log(JSON.stringify({ runs, fingerprint: fingerprint(exportsObject) }))
