// redis (node-redis) probe: client creation through the rebound factory —
// node-redis does not connect until .connect() is called.
import redis from 'redis'
import { report } from '../lib/probe-count.mts'

const client = redis.createClient({ socket: { host: '127.0.0.1', port: 1 } })

report(Boolean(client))
