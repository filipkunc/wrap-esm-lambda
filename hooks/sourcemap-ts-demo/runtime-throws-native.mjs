import './wrap-noop.mjs'
import { handler } from './handler.ts'
try {
  await handler({ foo: 'bar' }, {})
} catch (err) {
  console.log(err.stack)
}
