import { handler, lazy } from '@fake/comments/lazy-lib.js'

// `typeof` keeps `lazy` (and the ignored dynamic import inside it) alive
// through webpack's production tree-shaking without calling it at runtime
console.log(await handler('x'), typeof lazy)
