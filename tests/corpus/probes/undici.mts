// undici probe: a real (local) request through the rebound `request` export.
import { createServer } from 'node:http'
import undici from 'undici'
import { report } from '../lib/probe-count.mts'

const server = createServer((_req, res) => res.end('corpus')).listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('no port')

const { statusCode, body } = await undici.request(`http://127.0.0.1:${address.port}/`)
const text = await body.text()
server.close()

report(statusCode === 200 && text === 'corpus', `status=${statusCode}`)
