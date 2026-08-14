// A faithful stand-in for the runtime interface client's handler load
// (aws/aws-lambda-nodejs-runtime-interface-client, UserFunction): parse
// _HANDLER with the RIC's own split, resolve against LAMBDA_TASK_ROOT with
// its extension lookup order, dynamic-import, walk the property path, invoke
// once. The real thing — the image's own RIC answering a real invocation —
// runs in the CI Lambda lane; this file is the same load sequence for the
// lanes (and dev machines) where that image cannot run.
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const handlerString = process.env._HANDLER
// the real RIC refuses to boot without LAMBDA_TASK_ROOT; the sim is lenient
// so the spec can run the same load sequence in a deliberately un-Lambda
// environment and watch the config stay inert
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
console.log(await handler({ who: 'ric' }))
