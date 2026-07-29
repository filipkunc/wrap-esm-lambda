// The handler patch never names the handler: the platform chose the export's
// name (_HANDLER), the aws-lambda preset put it in the entry's bindings, and
// the tap's accessors are enumerable. Wall time and RSS from inside the
// process are the complement of the platform's own REPORT line (billed
// milliseconds, max memory) — the CI Lambda lane reads both and puts them
// side by side on the job summary.
export function recordInvocationMetrics(bindings) {
  for (const name of Object.keys(bindings)) {
    const original = bindings[name]
    bindings[name] = async (...args) => {
      const start = performance.now()
      try {
        return await original(...args)
      } finally {
        const ms = (performance.now() - start).toFixed(1)
        const rss = Math.round(process.memoryUsage.rss() / (1024 * 1024))
        console.log(`invocation = ${ms} ms, rss = ${rss} MB`)
      }
    }
  }
}
