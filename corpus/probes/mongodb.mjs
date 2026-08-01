// mongodb probe: MongoClient#db through the barrel import must cross the
// wrap applied at the defining module. No connection is made.
import { MongoClient } from 'mongodb'

const client = new MongoClient('mongodb://127.0.0.1:27017')
const db = client.db('corpus')

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(db && count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count}`)
