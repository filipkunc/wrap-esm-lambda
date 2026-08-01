// koa probe: app.use through the public API must cross the prototype wrap
// on the class handed over as "module.exports".
import Koa from 'koa'

const app = new Koa()
app.use(async () => {})

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(count > 0 ? 'PROBE:OK' : `PROBE:FAIL count=${count}`)
