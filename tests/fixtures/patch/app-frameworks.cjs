// CJS consumer of the same three frameworks: the pure require() chain,
// where fastify's rebinding of module.exports itself must be what
// require('fastify') returns, and hono resolves to its dist/cjs build.
const express = require('express')
const fastify = require('fastify')
const { Hono } = require('hono')

async function main() {
  const results = []

  results.push(express.json().__wrapped === true ? 'express:ok' : 'express:MISS')

  const app = fastify()
  results.push(app.__wrapped === true ? 'fastify:ok' : 'fastify:MISS')

  // only the mutation patch reaches the bundled CJS build (getter-only
  // exports cannot be rebound) — prototype route counting still works
  const hono = new Hono()
  const sub = new Hono()
  sub.get('/', (c) => c.text('hi'))
  hono.route('/sub', sub)
  const res = await hono.request('/sub')
  const honoOk = globalThis.__hono_routes === 1 && (await res.text()) === 'hi'
  results.push(honoOk ? 'hono:ok' : `hono:MISS(routes=${globalThis.__hono_routes})`)

  console.log(results.join(' '))
}

main()
