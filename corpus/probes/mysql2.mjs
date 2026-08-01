// mysql2 probe: pool creation through the rebound factory (pools connect
// lazily — nothing dials out).
import mysql from 'mysql2'

const pool = mysql.createPool({ host: '127.0.0.1', port: 1, user: 'corpus' })
pool.end(() => {})

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count}`)
