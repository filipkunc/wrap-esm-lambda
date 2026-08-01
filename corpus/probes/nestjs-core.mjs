// Nest-over-express patch-through probe: a minimal Nest app (decorators
// applied manually — the probe stays plain JS), one real HTTP round-trip,
// and the wrap on express's application.handle must have counted it.
import 'reflect-metadata'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

class AppController {
  hello() {
    return 'corpus'
  }
}
Controller()(AppController)
Get('hello')(AppController.prototype, 'hello', Object.getOwnPropertyDescriptor(AppController.prototype, 'hello'))

class AppModule {}
Module({ controllers: [AppController] })(AppModule)

const app = await NestFactory.create(AppModule, { logger: false })
await app.listen(0, '127.0.0.1')
const { port } = app.getHttpServer().address()
const res = await fetch(`http://127.0.0.1:${port}/hello`)
const text = await res.text()
await app.close()

const count = globalThis[Symbol.for('wrap-esm-lambda-corpus.probe')] ?? 0
console.log(
  res.status === 200 && text === 'corpus' && count > 0
    ? 'PROBE:OK'
    : `PROBE:FAIL count=${count} status=${res.status} body=${text}`,
)
