// redis (node-redis) probe: client creation through the rebound factory —
// node-redis does not connect until .connect() is called.
import redis from 'redis'

const client = redis.createClient({ socket: { host: '127.0.0.1', port: 1 } })

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(client && count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count}`)
