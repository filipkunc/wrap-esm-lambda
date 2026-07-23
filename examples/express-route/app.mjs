// A completely ordinary express app — nothing in this file knows it is being
// instrumented. It serves one parameterized route behind a mounted router,
// fires a request at itself, and exits.
import express from 'express'

const app = express()
const router = express.Router()
router.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
app.use('/api', router)

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const response = await fetch(`http://127.0.0.1:${server.address().port}/api/users/42`)
console.log('response =', await response.json())
server.close()
