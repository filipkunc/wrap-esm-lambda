// The CJS tree of the dual package — same API as index.mjs. Note fetchQuote
// calls getQuote directly (the idiomatic CJS shape): rebinding
// module.exports.getQuote cannot intercept that internal call, unlike the
// ESM tree where the live-binding rebind reaches it — the logger's output
// differs between the trees in exactly that one respect.
const QUOTES = ['stay hungry', 'ship it', 'make it work, make it right, make it fast']

function getQuote(id) {
  return QUOTES[id % QUOTES.length]
}

function shout(text) {
  return `${text.toUpperCase()}!`
}

async function fetchQuote(id) {
  await new Promise((resolve) => setImmediate(resolve))
  return getQuote(id)
}

function explode(reason) {
  throw new Error(`quote machine broke: ${reason}`)
}

module.exports = { getQuote, shout, fetchQuote, explode }
