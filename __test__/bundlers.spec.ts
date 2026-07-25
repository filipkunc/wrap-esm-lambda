import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The build-time shell across the real bundler matrix: the same tap-shapes
// fixture (every rewrite shape the tap unlocks, consumed through every
// import style) bundled by rollup, rolldown (Vite's engine), webpack and
// rspack —
// in production mode with terser, the harshest downstream consumer — for
// both transform engines. esbuild is covered by tap-shapes.spec.ts and
// acorn-engine.spec.ts; each build runs in a child process so
// WRAP_ESM_LAMBDA_ENGINE binds core to the engine under test. The suites run
// their legs concurrently — every leg is an isolated child process writing
// to its own temp dir, and serializing ~30 bundler builds would dominate the
// suite's wall clock.

const execFileAsync = promisify(execFile)
const driver = fileURLToPath(new URL('./fixtures/bundle-driver.mjs', import.meta.url))
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/tap-shapes/${name}`, import.meta.url))
const patchFixture = (name: string) => fileURLToPath(new URL(`./fixtures/patch/${name}`, import.meta.url))

const EXPECTED = 'wrapped:hi:x wrapped:hi:n wrapped:dflt:y patched:inner wrapped:greet ns:inner star:inner'

describe('tap rewrite shapes across the bundler matrix', { concurrency: true }, () => {
  for (const bundler of ['rollup', 'rolldown', 'webpack', 'rspack']) {
    for (const engineName of ['oxc', 'acorn']) {
      test(`${bundler} + ${engineName} engine: every tap rewrite shape lands and behaves`, async () => {
        const outDir = await mkdtemp(join(tmpdir(), `wrap-esm-lambda-${bundler}-${engineName}-`))
        try {
          const outfile = join(outDir, 'bundle.mjs')
          await execFileAsync(
            process.execPath,
            [driver, bundler, fixture('app-shapes.mjs'), fixture('wrap.config.shapes.mjs'), outfile],
            { env: { ...process.env, WRAP_ESM_LAMBDA_ENGINE: engineName } },
          )
          // plain node, no hooks — the instrumentation is baked into the bundle
          const { stdout } = await execFileAsync(process.execPath, [outfile])
          assert.strictEqual(stdout.trim(), EXPECTED)
        } finally {
          await rm(outDir, { recursive: true, force: true })
        }
      })
    }
  }
})

// The build shell's builtin reach: `node:os` has no source to transform, so
// the plugin aliases it to a generated wrapper module that patches the real
// exports object via process.getBuiltinModule and re-exports the patched
// bindings. Every consumer shape of the fixture — ESM named import, default
// import, and a runtime require() that escapes the aliasing entirely — must
// observe the patch from a plain `node bundle.mjs`. Engine-independent (the
// wrapper is generated, not parsed), so one run per bundler.
describe('builtin wrapper across the bundler matrix', { concurrency: true }, () => {
  for (const bundler of ['esbuild', 'rollup', 'rolldown', 'webpack', 'rspack']) {
    test(`${bundler}: builtin patched at build time via the wrapper module`, async () => {
      const outDir = await mkdtemp(join(tmpdir(), `wrap-esm-lambda-builtin-${bundler}-`))
      try {
        const outfile = join(outDir, 'bundle.mjs')
        await execFileAsync(process.execPath, [
          driver,
          bundler,
          patchFixture('app-builtin.mjs'),
          patchFixture('wrap.config.builtin.mjs'),
          outfile,
        ])
        const { stdout } = await execFileAsync(process.execPath, [outfile])
        assert.strictEqual(stdout.trim(), 'builtin:patched-all')
      } finally {
        await rm(outDir, { recursive: true, force: true })
      }
    })
  }
})

// The build shell's CJS reach: a pure-CJS `.js` package (no `"type"` field,
// no telling extension or path — express's exact layout) must be classified
// by syntax detection and receive require-delivery snippets — an appended
// ESM `import` would flip the module's format under each bundler's own
// syntax sniffing. Every bundler of the matrix, both engines.
describe('pure-CJS target across the bundler matrix', { concurrency: true }, () => {
  for (const bundler of ['esbuild', 'rollup', 'rolldown', 'webpack', 'rspack']) {
    for (const engineName of ['oxc', 'acorn']) {
      test(`${bundler} + ${engineName} engine: pure-CJS target patched at build time`, async () => {
        const outDir = await mkdtemp(join(tmpdir(), `wrap-esm-lambda-cjs-${bundler}-${engineName}-`))
        try {
          const outfile = join(outDir, 'bundle.mjs')
          await execFileAsync(
            process.execPath,
            [driver, bundler, fixture('app-cjs-lib.mjs'), fixture('wrap.config.cjs-lib.mjs'), outfile],
            { env: { ...process.env, WRAP_ESM_LAMBDA_ENGINE: engineName } },
          )
          const { stdout } = await execFileAsync(process.execPath, [outfile])
          assert.strictEqual(stdout.trim(), 'wrapped:hi:x')
        } finally {
          await rm(outDir, { recursive: true, force: true })
        }
      })
    }
  }
})
