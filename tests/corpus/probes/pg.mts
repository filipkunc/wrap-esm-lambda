// pg probe: a query issued through the public API must cross the wrapped
// Client.prototype.query. No server needed — an unconnected client queues
// the query, and the wrap is observed synchronously.
import pg from 'pg'
import { report } from '../lib/probe-count.mts'

const client = new pg.Client({ host: '127.0.0.1', port: 1 })
client.query('SELECT 1').catch(() => {})

report(true)
