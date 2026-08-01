// undici probe: a real (local) request through the rebound `request` export.
import { createServer } from 'node:http'
import undici from 'undici'

const server = createServer((req, res) => res.end('corpus')).listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const { port } = server.address()

const { statusCode, body } = await undici.request(`http://127.0.0.1:${port}/`)
const text = await body.text()
server.close()

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(statusCode === 200 && text === 'corpus' && count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count}`)
