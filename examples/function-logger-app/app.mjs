// A completely ordinary app — nothing here knows it is being instrumented.
import { getQuote, shout, fetchQuote, explode } from 'example-quotes'

console.log(shout(getQuote(1)))
console.log(await fetchQuote(2))
try {
  explode('demo')
} catch (err) {
  // the logger captured and rethrew — the app's own error handling still runs
  console.log(`app caught: ${err.message}`)
}
