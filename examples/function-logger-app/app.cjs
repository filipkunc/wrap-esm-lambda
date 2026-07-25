// The same app as a CJS consumer — require() resolves the dual package's
// CJS tree, and the identical installed instrumentation package covers it.
const { getQuote, shout, fetchQuote, explode } = require('example-quotes')

async function main() {
  console.log(shout(getQuote(1)))
  console.log(await fetchQuote(2))
  try {
    explode('demo')
  } catch (err) {
    // the logger captured and rethrew — the app's own error handling still runs
    console.log(`app caught: ${err.message}`)
  }
}

main()
