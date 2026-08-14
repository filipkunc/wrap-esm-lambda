// Stand-in for AWS Lambda's bootstrap, which is an ES module: the runtime
// interface client's entry is `index.mjs` (`"main": "dist/index.mjs"`,
// `"bin": {"aws-lambda-ric": "bin/index.mjs"}`), and the managed runtime
// boots `/var/runtime/index.mjs`. So the process main enters through the ESM
// loader, and the CJS side is reached from there via createRequire — the
// opposite of the Azure worker shape in bootstrap-sim.cjs.
//
// The handler is loaded late and indirectly, by the rule the RIC's
// UserFunction.js actually applies — extension first, `.js` decided by the
// nearest package.json `"type"`:
//
//   (pjHasModule && await _tryAwaitImport(p, '.js')) ||
//   (await _tryAwaitImport(p, '.mjs')) ||
//   _tryRequireFile(p, '.cjs')
//
// The instrumentation hook must already be registered (NODE_OPTIONS) and must
// survive this load.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = path.resolve(process.argv[2])

// nearest package.json "type", the same question Node itself asks for a .js
function isEsmByPackageType(from) {
  let dir = path.dirname(from)
  for (;;) {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).type === 'module'
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
  }
}

const ext = path.extname(entry)
const esm = ext === '.mjs' || (ext === '.js' && isEsmByPackageType(entry))

if (esm) {
  await import(pathToFileURL(entry).href)
} else {
  createRequire(import.meta.url)(entry)
}
