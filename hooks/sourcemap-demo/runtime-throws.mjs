import './wrap-noop.mjs'
import { handler } from './handler-throws.mjs'
try {
  await handler({ foo: 'bar' }, {})
} catch (err) {
  console.log(err.stack)
}
