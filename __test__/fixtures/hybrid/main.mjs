import { handler } from './handler.mjs'

console.log(await handler({ id: 42 }, {}))
