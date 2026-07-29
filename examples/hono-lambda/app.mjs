// A completely ordinary Hono app on AWS Lambda — nothing in this file knows
// it is being instrumented. hono/aws-lambda's handle() turns API Gateway
// events into fetch Requests, and the exported const is exactly the shape
// the runtime interface client loads (and the shape this repo was born to
// wrap). The S3 client is configured the way production code configures it
// on Lambda: not at all — region and credentials come from the execution
// environment, which the instrumentation config makes irrelevant anyway
// (see patches/aws-sdk.mjs).
import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const quotes = new Map([['42', 'Simplicity is prerequisite for reliability.']])
const s3 = new S3Client({})
const app = new Hono()

app.get('/quotes/:id', (c) => {
  const id = c.req.param('id')
  const quote = quotes.get(id)
  return quote ? c.json({ id, quote }) : c.json({ error: 'not found' }, 404)
})

app.post('/quotes', async (c) => {
  const { id, quote } = await c.req.json()
  quotes.set(id, quote)
  await s3.send(new PutObjectCommand({ Bucket: 'quotes-archive', Key: id, Body: quote }))
  return c.json({ stored: id }, 201)
})

export const handler = handle(app)
