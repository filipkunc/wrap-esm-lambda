// koa probe: app.use through the public API must cross the prototype wrap
// on the class handed over as "module.exports".
import Koa from 'koa'
import { report } from '../lib/probe-count.mts'

const app = new Koa()
app.use(async () => {})

report(true)
