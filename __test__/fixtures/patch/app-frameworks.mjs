// ESM consumer of all three frameworks. express and fastify arrive as
// CJS-through-the-ESM-loader (the corridor where Module._load patching was
// unreliable pre-fix); hono arrives through its real ESM build.
import express from 'express'
import { fastify } from 'fastify'
import { Hono } from 'hono'

const results = []

results.push(express.json().__wrapped === true ? 'express:ok' : 'express:MISS')

const app = fastify()
results.push(app.__wrapped === true ? 'fastify:ok' : 'fastify:MISS')

const hono = new Hono()
const sub = new Hono()
sub.get('/', (c) => c.text('hi'))
hono.route('/sub', sub)
const res = await hono.request('/sub')
const honoOk =
  globalThis.__hono_routes === 1 && // mutation patch (prototype route)
  globalThis.__hono_requests === 1 && // rebind patch (class-field request via subclass)
  (await res.text()) === 'hi'
results.push(
  honoOk ? 'hono:ok' : `hono:MISS(routes=${globalThis.__hono_routes},requests=${globalThis.__hono_requests})`,
)

console.log(results.join(' '))
