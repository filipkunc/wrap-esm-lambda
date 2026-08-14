// The pure require() chain: express and fastify capture identically; hono
// resolves to its bundled CJS build, whose getter-only exports cannot be
// rebound — route capture is knowingly absent there ('none'), never silent
// breakage of the app itself.
const express = require('express')
const fastify = require('fastify')
const { Hono } = require('hono')

const routes = () => globalThis[Symbol.for('wrap-esm-lambda.http-routes')] ?? {}

async function main() {
  const eApp = express()
  const eRouter = express.Router()
  eRouter.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
  eApp.use('/api', eRouter)
  const server = eApp.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  await fetch(`http://127.0.0.1:${server.address().port}/api/users/42`)
  server.close()

  const fApp = fastify()
  fApp.get('/users/:id', async (request) => ({ id: request.params.id }))
  await fApp.inject({ method: 'GET', url: '/users/42' })
  await fApp.close()

  const hSub = new Hono()
  hSub.get('/users/:id', (c) => c.json({ id: c.req.param('id') }))
  const hApp = new Hono()
  hApp.route('/api', hSub)
  const res = await hApp.request('/api/users/42')

  const { express: e = 'none', fastify: f = 'none', hono: h = 'none' } = routes()
  console.log(`express=${e} fastify=${f} hono=${h} hono-app=${res.status === 200 ? 'works' : 'broken'}`)
}

main()
