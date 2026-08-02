// knex probe: build real SQL through the rebound factory — no database
// needed, toString() compiles the query offline.
import knex from 'knex'
import { report } from '../lib/probe-count.mts'

const k = knex({ client: 'pg' })
const sql = k('users').where({ id: 1 }).select('name').toString()
await k.destroy()

report(/^select "name"/i.test(sql), `sql=${sql}`)
