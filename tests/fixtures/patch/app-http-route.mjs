// Fires one parameterized request through each framework and reports the
// captured http.route templates. Express serves over a real socket (its
// handle path needs one); fastify uses inject(), hono dispatches in-process.
import express from 'express'
import { fastify } from 'fastify'
import { Hono } from 'hono'

const routes = () => globalThis[Symbol.for('wrap-esm-lambda.http-routes')] ?? {}

// express: nested router, so the template composes baseUrl + route path
const eApp = express()
const eRouter = express.Router()
eRouter.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
eApp.use('/api', eRouter)
const server = eApp.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
await fetch(`http://127.0.0.1:${server.address().port}/api/users/42`)
server.close()

// fastify: inject() dispatches without a socket
const fApp = fastify()
fApp.get('/users/:id', async (request) => ({ id: request.params.id }))
await fApp.inject({ method: 'GET', url: '/users/42' })
await fApp.close()

// hono: mounted sub-app, dispatched in-process
const hSub = new Hono()
hSub.get('/users/:id', (c) => c.json({ id: c.req.param('id') }))
const hApp = new Hono()
hApp.route('/api', hSub)
await hApp.request('/api/users/42')

const { express: e = 'none', fastify: f = 'none', hono: h = 'none' } = routes()
console.log(`express=${e} fastify=${f} hono=${h}`)
