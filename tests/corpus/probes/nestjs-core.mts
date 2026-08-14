// Nest-over-express patch-through probe: a minimal Nest app (decorators
// applied manually — the probe stays decorator-config-free), one real HTTP
// round-trip, and the wrap on express's application.handle must have
// counted it.
import 'reflect-metadata'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { report } from '../lib/probe-count.mts'

class AppController {
  hello(): string {
    return 'corpus'
  }
}
Controller()(AppController)
Get('hello')(AppController.prototype, 'hello', Object.getOwnPropertyDescriptor(AppController.prototype, 'hello')!)

class AppModule {}
Module({ controllers: [AppController] })(AppModule)

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false })
await app.listen(0, '127.0.0.1')
const address = app.getHttpServer().address()
if (address === null || typeof address === 'string') throw new Error('no port')
const res = await fetch(`http://127.0.0.1:${address.port}/hello`)
const text = await res.text()
await app.close()

report(res.status === 200 && text === 'corpus', `status=${res.status} body=${text}`)
