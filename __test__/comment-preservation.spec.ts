import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as oxc from '../index.js'
// @ts-expect-error untyped workspace package
import * as acorn from '@wrap-esm-lambda/engine-acorn'

// Comments are load-bearing in bundled code: /* @__PURE__ */ annotations
// gate tree-shaking, webpackIgnore/webpackChunkName steer webpack's dynamic
// imports, /*! legal comments carry licenses (and our own double-wrap
// sentinel). The tap's fast path appends only, so it cannot touch them —
// but the REWRITE path regenerates (oxc) or edits (acorn) the module, so
// both engines must be pinned to keep every bundler-semantic comment. The
// build-mode matrix then proves the annotations still WORK downstream, in
// every bundler the unplugin ships an adapter for: the bundle must
// tree-shake on the surviving @__PURE__ (with an unannotated control kept),
// and webpack must honor a surviving webpackIgnore.

type Engine = typeof oxc
const engines: [string, Engine][] = [
  ['oxc', oxc],
  ['acorn', acorn as Engine],
]

const execFileAsync = promisify(execFile)
const driver = fileURLToPath(new URL('./fixtures/bundle-driver.mjs', import.meta.url))
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/comments/${name}`, import.meta.url))

const PRAGMA_SOURCE = [
  '/* license header v1.2.3 */',
  'export const handler = async (event) => event;',
  'const dropped = /* @__PURE__ */ globalThis.String("PURE_DROPPED");',
  'export function lazy() {',
  '  return import(/* webpackIgnore: true */ "./lazy.js");',
  '}',
  '/*! KEEP-LEGAL */',
  '',
].join('\n')

for (const [name, engine] of engines) {
  test(`${name}: the rewrite path keeps every bundler-semantic comment`, (t) => {
    const out = engine.exportsTap(
      PRAGMA_SOURCE,
      [{ bindings: ['handler'], patchName: 'patchIt', patchFrom: '/p.ts', aliasIndex: 0 }],
      false,
      true,
      'mod.js',
    )
    t.truthy(out.code, 'the const export must force the rewrite path')
    t.true(out.code!.includes('license header v1.2.3'), 'license comment survives')
    t.true(out.code!.includes('@__PURE__'), 'pure annotation survives')
    t.true(out.code!.includes('webpackIgnore: true'), 'webpack magic comment survives')
    t.true(out.code!.includes('KEEP-LEGAL'), 'legal comment survives')
  })
}

/** Bundle a comments-fixture entry through one adapter in a child process. */
async function bundleFixture(bundler: string, engineName: string, entry: string, outfile: string) {
  await execFileAsync(
    process.execPath,
    [driver, bundler, fixture(entry), fixture('wrap.config.comments.mjs'), outfile],
    { env: { ...process.env, WRAP_ESM_LAMBDA_ENGINE: engineName } },
  )
}

// Where each bundler leaves a /*! legal comment, as measured: esbuild and
// rolldown keep it in the bundle; webpack (terser) extracts it to
// <outfile>.LICENSE.txt; rollup drops trailing legal comments on its own —
// its users attach licenses via output.banner — so only the tree-shaking
// assertions apply there.
//
// Webpack ASI quirk, pinned while building this matrix: when a TREE-SHAKEN
// statement ends by ASI (no semicolon) and a comment plus any further
// statement follow it, webpack's production pipeline swallows the comment —
// on completely untransformed sources too. The fixture uses semicolon style
// (like published dist code) so every cell measures OUR transforms, not that
// quirk. It is engine-visible only indirectly: oxc codegen re-adds
// semicolons everywhere, the acorn engine preserves the author's style
// verbatim — so on semicolon-free sources webpack keeps the comment behind
// oxc and drops it behind acorn, with the transform itself blameless in
// both cases (the comment is present in each engine's emitted module).
const LEGAL_LOCATION: Record<string, 'bundle' | 'license-file' | 'dropped-by-bundler'> = {
  esbuild: 'bundle',
  rollup: 'dropped-by-bundler',
  rolldown: 'bundle',
  webpack: 'license-file',
}

for (const bundler of ['esbuild', 'rollup', 'rolldown', 'webpack']) {
  for (const [engineName] of engines) {
    test(`${bundler} + ${engineName} engine: surviving pragmas still steer the bundle`, async (t) => {
      const outDir = await mkdtemp(join(tmpdir(), `wel-comments-${bundler}-${engineName}-`))
      try {
        const outfile = join(outDir, 'bundle.mjs')
        await bundleFixture(bundler, engineName, 'app-comments.mjs', outfile)
        const bundled = await readFile(outfile, 'utf8')

        // the patch worked, so the module demonstrably took the rewrite path
        const { stdout } = await execFileAsync(process.execPath, [outfile])
        t.is(stdout.trim(), 'wrapped:hi:x')

        t.false(
          bundled.includes('PURE_DROPPED'),
          'the @__PURE__ call was tree-shaken — the annotation survived the rewrite',
        )
        t.true(
          bundled.includes('KEPT_MARKER'),
          'control: the unannotated call is kept, so shaking was annotation-driven',
        )
        if (LEGAL_LOCATION[bundler] === 'bundle') {
          t.true(bundled.includes('KEEP-LEGAL'), 'the legal comment reached the bundle')
        } else if (LEGAL_LOCATION[bundler] === 'license-file') {
          const license = await readFile(`${outfile}.LICENSE.txt`, 'utf8')
          t.true(license.includes('KEEP-LEGAL'), 'terser extracted the surviving legal comment')
        }
      } finally {
        await rm(outDir, { recursive: true, force: true })
      }
    })
  }
}

for (const [engineName] of engines) {
  test(`webpack + ${engineName} engine: a surviving webpackIgnore keeps the dynamic import at runtime`, async (t) => {
    const outDir = await mkdtemp(join(tmpdir(), `wel-webpack-ignore-${engineName}-`))
    try {
      const outfile = join(outDir, 'bundle.mjs')
      await bundleFixture('webpack', engineName, 'app-webpack.mjs', outfile)
      const bundled = await readFile(outfile, 'utf8')

      // the module took the rewrite path (const rebind) with the import intact
      const { stdout } = await execFileAsync(process.execPath, [outfile])
      t.is(stdout.trim(), 'wrapped:lz:x function')

      t.true(bundled.includes('./lazy.js'), 'the ignored import keeps its runtime specifier')
      const chunks = (await readdir(outDir)).filter((f) => f.endsWith('.mjs'))
      t.deepEqual(chunks, ['bundle.mjs'], 'webpackIgnore survived — no chunk was split off for lazy.js')
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
}
