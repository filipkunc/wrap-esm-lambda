// The RIC's load sequence pointed at this example, for the machines where
// the runtime image cannot run (the CI Lambda lane runs the same app through
// the REAL runtime interface client instead — .github/scripts/
// hono-lambda-rie.sh). Same rules as the RIC's UserFunction: parse _HANDLER
// on its first dot, resolve against LAMBDA_TASK_ROOT with the '', '.js',
// '.mjs', '.cjs' lookup order, dynamic-import, walk the property path — then
// answer the events named on the command line (defaulting to the two API
// Gateway v2 events), the same JSON the CI script POSTs at the emulator.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const handlerString = process.env._HANDLER ?? 'app.handler'
const taskRoot = process.env.LAMBDA_TASK_ROOT ?? process.cwd()
const handlerBase = basename(handlerString)
const moduleRoot = handlerString.slice(0, handlerString.indexOf(handlerBase))
const match = handlerBase.match(/^([^.]*)\.(.*)$/)
const prefix = resolve(taskRoot, moduleRoot, match[1])

let mod
for (const extension of ['', '.js', '.mjs', '.cjs']) {
  const file = prefix + extension
  if (existsSync(file)) {
    mod = await import(pathToFileURL(file).href)
    break
  }
}
if (!mod) throw new Error(`no module for ${handlerString} under ${taskRoot}`)
const handler = match[2].split('.').reduce((nested, key) => nested && nested[key], mod)

const names = process.argv.length > 2 ? process.argv.slice(2) : ['get-quote', 'post-quote']
for (const name of names) {
  const event = JSON.parse(await readFile(new URL(`./events/${name}.json`, import.meta.url), 'utf8'))
  const response = await handler(event, { functionName: 'hono-lambda-local' })
  if (event.Records) {
    console.log(`SQS batch of ${event.Records.length} -> ${JSON.stringify(response)}`)
  } else {
    console.log(`${event.requestContext.http.method} ${event.rawPath} -> ${response.statusCode} ${response.body}`)
  }
}
