import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyMatched } from '@wrap-esm-lambda/core'

// The CJS evaluation wrap (core/cjs-wrap.mts): a CJS module body runs inside
// the wrapper FUNCTION Node (or a bundler) provides, so a top-level `return`
// makes everything textually after it dead — a tap that were merely appended
// would silently never run. These tests pin that the tap survives the
// early-exit shape, and that the arrow-IIFE wrap preserves what enclosing a
// module body most plausibly breaks: the directive prologue (strict mode),
// function hoisting, cjs-module-lexer's named-export detection, an upstream
// source map under --enable-source-maps, and the
// do-not-patch-a-throwing-module rule. (Why an arrow IIFE and not
// `try/finally` is cjs-wrap.mts's story: a block-scoped sloppy `function`
// gets renamed by bundlers' Annex B lowering — the corpus caught esbuild
// turning graceful-fs's `patch` into `patch2`.)
//
// Instrumented modules always run in a plain child `node`: the test
// harness's own loader (@oxc-node/core) rejects top-level `return` when
// require()ing a `.cjs` in-process, and a bare child is the honest
// consumer anyway.

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))

const entryFor = (from: string, bindings: string[] = ['greet']) => [
  {
    module: { name: '@fake/early-return', versionRange: '>=1 <2', files: ['index.js'] },
    patch: { name: 'patchIt', from },
    bindings,
  },
]

/** Instrument `source` (import delivery) and write it plus a patch module. */
async function instrumented(dir: string, source: string, patchBody: string): Promise<string> {
  const patchPath = join(dir, 'patch.cjs')
  await writeFile(patchPath, patchBody)
  const applied = applyMatched(source, entryFor(patchPath), join(dir, 'index.js'), { format: 'commonjs' })
  assert.notStrictEqual(applied, null, 'the entry applies')
  const modPath = join(dir, 'mod.cjs')
  await writeFile(modPath, applied!.code)
  return modPath
}

const WRAPPING_PATCH = `exports.patchIt = (bindings) => {
  const orig = bindings.greet
  bindings.greet = (name) => 'wrapped:' + orig(name)
}
`

test('runtime mode: a top-level return does not skip the tap', async () => {
  // The fixture module also probes, from inside, everything the wrap must
  // not break: its ASI directive prologue stays a prologue (strict:true) and
  // `greet` is callable above its declaration (hoisted:hi:hoist).
  const env = { ...process.env, WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.early-return.mjs') }
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', '@wrap-esm-lambda/hooks/register', fixture('app-early-return.cjs')],
    { env },
  )
  assert.strictEqual(stdout.trim(), 'wrapped:hi:x strict:true hoisted:hi:hoist')
})

test('build delivery: the wrap patches through the early return, string and Buffer alike', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-early-'))
  try {
    const source = `'use strict'
exports.greet = function greet(name) { return 'hi:' + name }
if (typeof process !== 'undefined') { return }
exports.late = true
`
    const modPath = await instrumented(dir, source, WRAPPING_PATCH)
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      `const m = require(${JSON.stringify(modPath)}); console.log(m.greet('x'), 'late' in m)`,
    ])
    assert.strictEqual(stdout.trim(), 'wrapped:hi:x false', 'patched, and the early return still returned early')

    // byte path parity: the Buffer splice produces the identical module
    const patchPath = join(dir, 'patch.cjs')
    const viaBuffer = applyMatched(Buffer.from(source), entryFor(patchPath), join(dir, 'index.js'), {
      format: 'commonjs',
    })
    const viaString = applyMatched(source, entryFor(patchPath), join(dir, 'index.js'), { format: 'commonjs' })
    assert.ok(Buffer.isBuffer(viaBuffer!.code), 'bytes in, bytes out')
    assert.strictEqual(String(viaBuffer!.code), viaString!.code as string)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a module that throws mid-evaluation stays unpatched, error intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-early-'))
  try {
    const source = `exports.greet = function greet(name) { return 'hi:' + name }
throw new Error('boom')
`
    const modPath = await instrumented(
      dir,
      source,
      `exports.patchIt = () => { globalThis.__earlyReturnPatchRan = true }
`,
    )
    const probe = `try { require(${JSON.stringify(modPath)}) } catch (err) {
  console.log('err:' + err.message, 'patched:' + (globalThis.__earlyReturnPatchRan === true))
}`
    const { stdout } = await execFileAsync(process.execPath, ['-e', probe])
    assert.strictEqual(stdout.trim(), 'err:boom patched:false', 'a failed evaluation is not patched')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cjs-module-lexer still detects named exports through the wrap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-early-'))
  try {
    const source = `exports.greet = function greet(name) { return 'hi:' + name }
if (typeof process !== 'undefined') { return }
`
    const modPath = await instrumented(dir, source, WRAPPING_PATCH)
    // a STATIC named import of a CJS module links only if Node's lexer finds
    // the name in the (wrapped) source — a namespace import would not prove
    // that
    const runner = join(dir, 'runner.mjs')
    await writeFile(
      runner,
      `import { greet } from ${JSON.stringify(pathToFileURL(modPath).href)}
console.log(greet('x'))
`,
    )
    const { stdout } = await execFileAsync(process.execPath, [runner])
    assert.strictEqual(stdout.trim(), 'wrapped:hi:x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the wrap adds no scope-visible binding a source could collide with', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-early-'))
  try {
    // the arrow IIFE introduces no names at all — a module free to use any
    // identifier (here one that LOOKS like ours) cannot clash with the wrap
    const source = `var __wel_ok = 'mine'
exports.greet = function greet(name) { return 'hi:' + name + ':' + __wel_ok }
if (typeof process !== 'undefined') { return }
`
    const modPath = await instrumented(dir, source, WRAPPING_PATCH)
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      `console.log(require(${JSON.stringify(modPath)}).greet('x'))`,
    ])
    assert.strictEqual(stdout.trim(), 'wrapped:hi:x:mine')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sloppy-mode function declarations keep their names through bundling', async () => {
  // THE reason the wrap is an arrow IIFE: inside a `try { }` block a sloppy
  // `function` declaration falls under Annex B, and esbuild's lowering
  // renames it — graceful-fs's `patch` became `patch2`, an observable
  // Function.name change the corpus caught. A function body adds no block,
  // so nothing is renamed.
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-early-'))
  try {
    const source = `function patch(fs) { return fs }
exports.gracefulify = patch
if (typeof process !== 'undefined') { return }
`
    const modPath = await instrumented(dir, source, WRAPPING_PATCH.replace(/greet/g, 'gracefulify'))
    const { build } = await import('esbuild')
    const outfile = join(dir, 'bundle.mjs')
    await build({
      entryPoints: [modPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      logLevel: 'silent',
    })
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      `import(${JSON.stringify(pathToFileURL(outfile).href)}).then((m) => console.log(m.default.gracefulify.name))`,
    ])
    assert.strictEqual(stdout.trim(), 'patch', 'Function.name survives the bundler')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an upstream source map still resolves stack frames after the wrap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-early-'))
  try {
    // the wrap prefix carries no newline, so a module's own inline map keeps
    // resolving line-accurately under --enable-source-maps; the frame must
    // match the UNWRAPPED module's exactly
    const { transform } = await import('esbuild')
    const ts = `export function greet(name: string): string {
  return 'hi:' + name
}
export function boom(): never {
  throw new Error('mapped')
}
boom()
`
    const { code: compiled } = await transform(ts, {
      loader: 'ts',
      format: 'cjs',
      platform: 'node',
      sourcemap: 'inline',
      sourcefile: 'src.ts',
    })
    const frameOf = async (file: string): Promise<string> => {
      const { stderr } = await execFileAsync(process.execPath, ['--enable-source-maps', file]).catch((err) => err)
      const frame = (stderr as string).split('\n').find((line) => line.includes('at boom'))
      assert.ok(frame, 'the mapped frame is present')
      return frame.trim().replace(/\(.*src\.ts/, '(src.ts')
    }
    const plainPath = join(dir, 'plain.cjs')
    await writeFile(plainPath, compiled)
    const modPath = await instrumented(dir, compiled, WRAPPING_PATCH)
    assert.strictEqual(await frameOf(modPath), await frameOf(plainPath))
    assert.match(await frameOf(modPath), /src\.ts:5:/, 'the frame points into the original TS')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a leading string that is NOT a directive stays intact inside the wrap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wrap-esm-lambda-early-'))
  try {
    // `'use strict'\n.length` is ONE member expression — a wrap that hoisted
    // the string as a directive would split it. The IIFE hoists nothing: the
    // whole body moves as-is, and real directives simply become the arrow
    // body's own prologue (the e2e fixture pins that via strict:true).
    const source = `'use strict'
.length
exports.greet = function greet(name) { return 'hi:' + name }
`
    const modPath = await instrumented(dir, source, WRAPPING_PATCH)
    const applied = applyMatched(source, entryFor(join(dir, 'patch.cjs')), join(dir, 'index.js'), {
      format: 'commonjs',
    })
    assert.match(applied!.code as string, /^;\(\(\) => \{ 'use strict'/, 'the body opens right after the prefix')
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      `console.log(require(${JSON.stringify(modPath)}).greet('x'))`,
    ])
    assert.strictEqual(stdout.trim(), 'wrapped:hi:x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
