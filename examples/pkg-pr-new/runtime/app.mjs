// A completely ordinary hono app — nothing in this file knows it is being
// instrumented. Hono is fetch-based, so no server is needed: app.request()
// dispatches a request in-process. It serves one route, calls it, and exits.
import { Hono } from 'hono'

const app = new Hono()
app.get('/hello/:name', (c) => c.json({ hello: c.req.param('name') }))

const response = await app.request('/hello/world')
console.log('response =', await response.json())
