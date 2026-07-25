// An entirely ordinary library — it knows nothing about instrumentation.
// The function-logger package targets it purely by package name + file.
const QUOTES = ['stay hungry', 'ship it', 'make it work, make it right, make it fast']

export function getQuote(id) {
  return QUOTES[id % QUOTES.length]
}

export function shout(text) {
  return `${text.toUpperCase()}!`
}

export async function fetchQuote(id) {
  await new Promise((resolve) => setImmediate(resolve))
  return getQuote(id)
}

export function explode(reason) {
  throw new Error(`quote machine broke: ${reason}`)
}
