// A completely ordinary express app — nothing in this file knows it is being
// instrumented. It serves one route, fires a request at itself, and exits.
import express from 'express'

const app = express()
app.get('/hello/:name', (req, res) => res.json({ hello: req.params.name }))

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const response = await fetch(`http://127.0.0.1:${server.address().port}/hello/world`)
console.log('response =', await response.json())
server.close()
