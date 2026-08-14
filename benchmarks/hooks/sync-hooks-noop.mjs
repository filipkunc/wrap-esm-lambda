// The floor: a registered load hook that transforms nothing. What the
// mechanism itself costs before any tool does any work.
import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, nextLoad) {
    return nextLoad(url, context)
  },
})
