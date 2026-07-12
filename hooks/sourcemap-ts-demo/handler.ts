// A TypeScript Lambda handler. `tsc` strips the types below and emits
// handler.js + handler.js.map; our transform then wraps the handler. The type
// annotations here shift line numbers, so only a chained source map can point
// an exception back to this .ts file.
interface LambdaEvent {
  id?: number
}

type Handler = (event: LambdaEvent) => Promise<string>

export const handler: Handler = async (event: LambdaEvent): Promise<string> => {
  const detail: { id: number } = { id: event?.id ?? 42 }

  // the failing line is line 15 in THIS original .ts file
  throw new Error(`boom for ${detail.id}`)
}
