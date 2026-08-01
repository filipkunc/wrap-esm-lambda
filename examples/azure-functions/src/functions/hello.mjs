import { app } from '@azure/functions'

app.http('hello', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // measurable handler time, so the report's innermost number is visibly
    // distinct from the callback phase carrying the fake agent's wrapper
    await new Promise((resolve) => setTimeout(resolve, 15))
    const name = request.query.get('name') ?? 'Azure'
    context.log(`hello invoked for ${name}`)
    return { body: `Hello, ${name}!` }
  },
})
