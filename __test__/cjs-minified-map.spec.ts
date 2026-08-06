import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMatched, inlineMap } from '@wrap-esm-lambda/core'

// Real-world minified bundled CJS vs the CJS evaluation wrap (cjs-wrap.mts).
// A production minified bundle is ONE line: js-yaml ships dist/js-yaml.min.js
// as 43KB of terser output on line 1 plus an external source map whose
// mappings are all line-0 columns. The wrap's 10-char prefix `;(() => { `
// shifts every one of those columns, so a merely spliced tap would leave the
// module's own map resolving every stack frame 10 columns early — wrong
// function, wrong original line, silently. These tests pin the fix:
// `applyMatched` returns a corrected copy of the module's own map (first
// mapped segment of the insertion line shifted by the prefix width), the
// runtime hook inlines it after the code (the LAST sourceMappingURL comment
// wins), and mapped stack frames come out IDENTICAL to the unwrapped
// module's. The specimen is the real shipped npm artifact, not a synthetic
// minification.
//
// Instrumented modules run in a plain child `node` (same reason as
// cjs-early-return.spec.ts: the harness's in-process loader is not the
// honest consumer).

const execFileAsync = promisify(execFile)
const require_ = createRequire(import.meta.url)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))

const yamlPkg = dirname(require_.resolve('js-yaml/package.json'))
const yamlMin = join(yamlPkg, 'dist', 'js-yaml.min.js')
const yamlMinMap = join(yamlPkg, 'dist', 'js-yaml.min.js.map')

const entryFor = (from: string, bindings: string[]) => [
  {
    module: { name: 'yaml-mini', versionRange: '>=4 <5', files: ['js-yaml.min.js'] },
    patch: { name: 'patchYamlMini', from },
    bindings,
  },
]

const CJS_PATCH = `exports.patchYamlMini = (bindings) => {
  const orig = bindings.load
  bindings.load = (input, opts) => ({ __viaPatch: true, value: orig(input, opts) })
}
`

/** The probe every child runs: a deep mapped throw, then proof the patch ran. */
const appSource = (requireSpec: string) => `'use strict'
const yaml = require(${JSON.stringify(requireSpec)})
let stack = ''
try {
  yaml.load('a: [')
} catch (err) {
  stack = String(err.stack)
}
const probe = yaml.load('ok: 1')
console.log('patched:' + (probe !== null && typeof probe === 'object' && probe.__viaPatch === true))
console.log(stack)
`

/** Frames that resolved into the bundle's original sources (lib/*.js). */
function libFrames(stdout: string): { patched: string; frames: string[] } {
  const lines = stdout.split('\n')
  assert.match(lines[0]!, /^patched:(true|false)$/, 'the probe line is present')
  return {
    patched: lines[0]!,
    // strip V8's receiver prefix (`at Object.G.load` vs `at G.load`): the
    // patch wrapper calls the original binding as a plain function, which
    // changes the receiver, not the mapped position or name
    frames: lines
      .filter((line) => /at .*[\\/]lib[\\/][^)]+\.js:\d+:\d+/.test(line))
      .map((line) => line.trim().replace(/^at Object\./, 'at ')),
  }
}

test('runtime mode: the real js-yaml minified dist keeps its source map through the wrap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-minmap-'))
  try {
    // assemble a package whose main IS the real shipped minified artifact,
    // external map beside it exactly as npm delivers it
    const pkgDir = join(dir, 'node_modules', 'yaml-mini')
    await mkdir(pkgDir, { recursive: true })
    const { version } = require_('js-yaml/package.json') as { version: string }
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'yaml-mini', version, main: './js-yaml.min.js', type: 'commonjs' }),
    )
    await copyFile(yamlMin, join(pkgDir, 'js-yaml.min.js'))
    await copyFile(yamlMinMap, join(pkgDir, 'js-yaml.min.js.map'))
    const app = join(dir, 'app.cjs')
    await writeFile(app, appSource('yaml-mini'))

    const control = libFrames((await execFileAsync(process.execPath, ['--enable-source-maps', app])).stdout)
    const env = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.yaml-mini.mjs') }
    const instrumented = libFrames(
      (
        await execFileAsync(
          process.execPath,
          ['--enable-source-maps', '--import', '@wrap-esm-lambda/hooks/register', app],
          { env },
        )
      ).stdout,
    )

    assert.strictEqual(control.patched, 'patched:false')
    assert.strictEqual(instrumented.patched, 'patched:true', 'the patch reached the minified bundle')
    assert.ok(control.frames.length >= 3, `the throw maps deep into lib/ (got ${control.frames.length} frames)`)
    assert.ok(
      control.frames.some((frame) => /loader\.js:\d+:\d+/.test(frame)),
      'the mapped frames point into the original loader.js',
    )
    assert.deepStrictEqual(
      instrumented.frames,
      control.frames,
      'every mapped frame of the wrapped module is identical to the unwrapped one',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('build delivery: applyMatched corrects the bundle map, string and Buffer alike', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-minmap-'))
  try {
    const source = await readFile(yamlMin, 'utf8')
    const patchPath = join(dir, 'patch.cjs')
    await writeFile(patchPath, CJS_PATCH)
    // the external map must sit where the module's sourceMappingURL points
    // BEFORE the apply step — that is where the wrap discovers it
    const id = join(dir, 'wrapped', 'js-yaml.min.js')
    await mkdir(join(dir, 'wrapped'), { recursive: true })
    await copyFile(yamlMinMap, join(dir, 'wrapped', 'js-yaml.min.js.map'))
    const viaString = applyMatched(source, entryFor(patchPath, ['load']), id, { format: 'commonjs' })
    const viaBuffer = applyMatched(Buffer.from(source), entryFor(patchPath, ['load']), id, { format: 'commonjs' })
    assert.notStrictEqual(viaString, null)
    assert.ok(typeof viaString!.map === 'string', 'the wrap hands back a corrected copy of the module map')
    assert.ok(Buffer.isBuffer(viaBuffer!.code), 'bytes in, bytes out')
    assert.strictEqual(String(viaBuffer!.code), viaString!.code as string, 'byte path parity')
    assert.strictEqual(viaBuffer!.map, viaString!.map, 'map parity across the byte path')

    // behavioral proof: a consumer that inlines the returned map (what the
    // runtime hook does; a bundler composes it instead) gets stack frames
    // identical to the untouched artifact — original external map still
    // sitting beside both copies
    const controlDir = join(dir, 'control')
    const wrappedDir = join(dir, 'wrapped')
    await mkdir(controlDir, { recursive: true })
    await copyFile(yamlMin, join(controlDir, 'js-yaml.min.js'))
    await copyFile(yamlMinMap, join(controlDir, 'js-yaml.min.js.map'))
    await writeFile(id, inlineMap(viaString!.code, viaString!.map!))

    const runOn = async (file: string) => {
      const probe = join(dirname(file), 'run.cjs')
      await writeFile(probe, appSource(file))
      return libFrames((await execFileAsync(process.execPath, ['--enable-source-maps', probe])).stdout)
    }
    const control = await runOn(join(controlDir, 'js-yaml.min.js'))
    const wrapped = await runOn(id)
    assert.strictEqual(control.patched, 'patched:false')
    assert.strictEqual(wrapped.patched, 'patched:true')
    assert.ok(control.frames.length >= 3, 'the throw maps deep into lib/')
    // tmp dirs differ per copy — compare frames with the directory stripped
    const relative = (frames: string[], root: string) => frames.map((frame) => frame.replaceAll(root, '<dir>'))
    assert.deepStrictEqual(relative(wrapped.frames, wrappedDir), relative(control.frames, controlDir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a mapped bundle whose first line is a banner needs no correction: map stays null', async () => {
  // axios ships its minified dist with a copyright banner on line 1, so the
  // wrap prefix only shifts columns of an unmapped comment line — emitting a
  // corrected map there would be pure output bloat. The map's own first line
  // is empty; the wrap must notice and stay quiet.
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-minmap-'))
  try {
    const axiosMin = fileURLToPath(new URL('../corpus/node_modules/axios/dist/axios.min.js', import.meta.url))
    const patchPath = join(dir, 'patch.cjs')
    await writeFile(patchPath, CJS_PATCH)
    const applied = applyMatched(
      await readFile(axiosMin, 'utf8'),
      entryFor(patchPath, ['Axios']),
      join(dir, 'js-yaml.min.js'),
      { format: 'commonjs' },
    )
    assert.notStrictEqual(applied, null)
    assert.strictEqual(applied!.map, null, 'no mapped segment moved, so no map is emitted')
    assert.match(applied!.code as string, /^;\(\(\) => \{ \/\*!/, 'the banner line took the prefix')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
