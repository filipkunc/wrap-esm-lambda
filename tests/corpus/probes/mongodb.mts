// mongodb probe: MongoClient#db through the barrel import must cross the
// wrap applied at the defining module. No connection is made.
import { MongoClient } from 'mongodb'
import { report } from '../lib/probe-count.mts'

const client = new MongoClient('mongodb://127.0.0.1:27017')
const db = client.db('corpus')

report(Boolean(db))
