// knex probe: build real SQL through the rebound factory — no database
// needed, toString() compiles the query offline.
import knex from 'knex'

const k = knex({ client: 'pg' })
const sql = k('users').where({ id: 1 }).select('name').toString()
await k.destroy()

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(/^select "name"/i.test(sql) && count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count} sql=${sql}`)
