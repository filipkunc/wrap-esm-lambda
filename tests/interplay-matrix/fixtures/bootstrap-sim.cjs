// Stand-in for a CJS platform bootstrap: Azure Functions' node worker is a
// CJS bundle (`dist/src/nodejsWorker.js`) that starts first and loads the
// user's handler afterwards — dynamic import() for ESM entries, require()
// for CJS. The instrumentation hook must already be registered (via
// languageWorkers__node__arguments / NODE_OPTIONS) and must survive this
// late, indirect load of the actual app.
//
// Lambda is NOT this shape: its runtime interface client entry is an ES
// module, which is bootstrap-sim.mjs next door. Both mains are exercised
// because which loader the process enters through is exactly the variable
// this matrix exists to hold still.
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
