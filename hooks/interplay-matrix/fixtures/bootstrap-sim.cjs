// Minimal stand-in for a serverless platform bootstrap: AWS Lambda's runtime
// interface client and Azure Functions' node worker are both CJS bundles
// that start first and load the user's handler afterwards — dynamic import()
// for ESM entries, require() for CJS. The instrumentation hook must already
// be registered (via NODE_OPTIONS / languageWorkers arguments) and must
// survive this late, indirect load of the actual app.
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const entry = path.resolve(process.argv[2])
if (entry.endsWith('.cjs')) {
  require(entry)
} else {
  import(pathToFileURL(entry).href).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
