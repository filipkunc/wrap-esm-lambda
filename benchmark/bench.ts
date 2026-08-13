import { measureTransforms } from './transform-results.js'

// Production transform diagnostics. Each engine runs in its own process and
// reaches the same applyMatched() entry point used by hooks and bundlers.
console.log('production transform latency (Tinybench):')
for (const result of await measureTransforms()) {
  const detail = `p50 ${result.p50Us.toFixed(1)} µs · p99 ${result.p99Us.toFixed(1)} µs · ±${result.rme.toFixed(1)}% · n=${result.samples}`
  console.log(`${`${result.engine}: ${result.operation}`.padEnd(74)} ${detail}`)
}
