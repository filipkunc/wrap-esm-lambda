// registerHooks/Module._load interplay matrix: runs the scenarios/ suite
// against a ladder of official Node builds straddling the #59929 fix train
// (v22.22.3 / v24.11.1 / v25.1.0), plus this repo's real runtime hook, and
// writes the result table to matrix.md. Linux x64 only (downloads official
// tarballs from nodejs.org and extracts just bin/node).
//
//   node hooks/interplay-matrix/run.mjs             # full ladder
//   node hooks/interplay-matrix/run.mjs 22.22.2 ... # explicit versions
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error('interplay-matrix downloads linux-x64 Node builds; run it on linux/x64')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

// The ladder brackets each line's fix boundary: 22.15.0 is registerHooks'
// arrival on 22.x, 22.16.0-22.18.0 the reported-broken range of
// nodejs/node#59384, 22.22.2/24.11.0 the last pre-fix minors, 22.22.3 and
// 24.11.1 the fix releases, and the tails are current.
const DEFAULT_VERSIONS = [
  '22.15.0',
  '22.16.0',
  '22.18.0',
  '22.22.2',
  '22.22.3',
  '22.23.1',
  '24.10.0',
  '24.11.0',
  '24.11.1',
  '24.18.0',
  '26.5.0',
]
const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_VERSIONS

const scenarioDir = join(here, 'scenarios')
const scenarios = readdirSync(scenarioDir)
  .filter((f) => f.endsWith('.mjs'))
  .sort()

// The repo's real runtime hook (native tap addon + registerHooks shell) on
// the patch fixture app, in both module systems. napi addons are ABI-stable,
// so one build serves every Node in the ladder.
const tapFixture = (name) => join(repoRoot, '__test__', 'fixtures', 'patch', name)
const tapEnv = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: tapFixture('wrap.config.mjs') }
// The serverless delivery shape: on managed runtimes the CLI is not ours to
// change — AWS Lambda injects flags via the NODE_OPTIONS env var, Azure
// Functions via languageWorkers__node__arguments — and the process' main is
// the platform's CJS bootstrap (Lambda RIC / Azure node worker), which loads
// the user handler afterwards.
const nodeOptionsEnv = { ...tapEnv, NODE_OPTIONS: '--import @wrap-esm-lambda/hooks/register' }
const bootstrap = join(here, 'fixtures', 'bootstrap-sim.cjs')
const E2E = [
  {
    name: 'wrap-esm-lambda-tap-esm',
    args: ['--import', '@wrap-esm-lambda/hooks/register', tapFixture('app.mjs')],
    env: tapEnv,
    expect: 'patched:sent:hello',
  },
  {
    name: 'wrap-esm-lambda-tap-cjs',
    args: ['--import', '@wrap-esm-lambda/hooks/register', tapFixture('app.cjs')],
    env: tapEnv,
    expect: 'patched:sent:hello',
  },
  {
    name: 'tap-node-options-esm',
    args: [tapFixture('app.mjs')],
    env: nodeOptionsEnv,
    expect: 'patched:sent:hello',
  },
  {
    name: 'tap-bootstrap-esm',
    args: [bootstrap, tapFixture('app.mjs')],
    env: nodeOptionsEnv,
    expect: 'patched:sent:hello',
  },
  {
    name: 'tap-bootstrap-cjs',
    args: [bootstrap, tapFixture('app.cjs')],
    env: nodeOptionsEnv,
    expect: 'patched:sent:hello',
  },
]

const cacheDir = join(tmpdir(), 'wrap-esm-lambda-node-matrix')
mkdirSync(cacheDir, { recursive: true })

function nodeBinFor(version) {
  const bin = join(cacheDir, `node-${version}`)
  if (existsSync(bin)) return bin
  const name = `node-v${version}-linux-x64`
  const tar = join(cacheDir, `${name}.tar.xz`)
  console.error(`downloading ${name}...`)
  execFileSync('curl', ['-fsSL', `https://nodejs.org/dist/v${version}/${name}.tar.xz`, '-o', tar])
  execFileSync('tar', ['-xJf', tar, '-C', cacheDir, `${name}/bin/node`])
  execFileSync('mv', [join(cacheDir, name, 'bin', 'node'), bin])
  rmSync(tar, { force: true })
  rmSync(join(cacheDir, name), { recursive: true, force: true })
  return bin
}

// One cell: RESULT:<token> from the scenario, or the failure class
// (ERR_* code when one is recognizable) when the process dies.
function runCell(nodeBin, args, opts = {}) {
  const res = spawnSync(nodeBin, args, { encoding: 'utf8', timeout: 30000, ...opts })
  const out = (res.stdout ?? '').trim()
  const resultLine = out
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('RESULT:'))
  if (resultLine) return resultLine.slice('RESULT:'.length)
  if (opts.expect !== undefined) return out === opts.expect ? 'OK' : `FAIL(${out || 'no output'})`
  const err = (res.stderr ?? '').match(/ERR_[A-Z_]+/)
  return err ? err[0] : `EXIT_${res.status}`
}

const table = []
for (const version of versions) {
  const nodeBin = nodeBinFor(version)
  const row = { version }
  for (const scenario of scenarios) {
    row[scenario.replace('.mjs', '')] = runCell(nodeBin, [join(scenarioDir, scenario)])
  }
  for (const { name, args, env, expect } of E2E) {
    row[name] = runCell(nodeBin, args, { cwd: repoRoot, env, expect })
  }
  console.error(`${version}: done`)
  table.push(row)
}

const columns = ['version', ...scenarios.map((s) => s.replace('.mjs', '')), ...E2E.map((e) => e.name)]
const lines = [
  `| ${columns.join(' | ')} |`,
  `|${columns.map(() => '---').join('|')}|`,
  ...table.map((row) => `| ${columns.map((c) => row[c]).join(' | ')} |`),
]
const md = `${lines.join('\n')}\n`
console.log(md)
writeFileSync(join(here, 'matrix.md'), md)
console.error(`written to ${join(here, 'matrix.md')}`)
