// mysql2 probe: pool creation through the rebound factory (pools connect
// lazily — nothing dials out).
import mysql from 'mysql2'
import { report } from '../lib/probe-count.mts'

const pool = mysql.createPool({ host: '127.0.0.1', port: 1, user: 'corpus' })
pool.end(() => {})

report(true)
