// CJS consumer cell: require() the corpus package — for pure-ESM packages
// this exercises require(esm). Same report shape as the import consumer.
//
// DELIBERATE JavaScript (.cjs) in a TypeScript corpus — load-bearing, do
// not convert (CORPUS FINDING #5): a TYPE-STRIPPED CJS entry (.cts) that
// require()s a hook-transformed ESM module fails to link on the whole 22.x
// line ("request for X is from a module not been linked"), even on
// 22.23.1, past the nodejs/node#59929 fix train; fixed on 24.18.0 / 26.x.
// Only the entry triggers it — a stripped .cts HELPER under a plain .cjs
// entry works everywhere, which is why fingerprint.cts stays TypeScript.
// Converting this file would silently change the corridor the cell exists
// to test, and on Node 22 break it.
'use strict'
const { fingerprint } = require('./fingerprint.cts')

const pkg = process.env.CORPUS_PKG
if (!pkg) throw new Error('CORPUS_PKG not set')

const exportsObject = require(pkg)
const runs = globalThis[Symbol.for('wrap-esm-lambda-corpus.runs')] ?? 0
console.log(JSON.stringify({ runs, fingerprint: fingerprint(exportsObject) }))
