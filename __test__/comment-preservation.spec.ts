import test from 'ava'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
// build-mode tests then prove the annotations still WORK downstream: an
// esbuild bundle produced through the unplugin must tree-shake on the
// surviving @__PURE__ and retain the legal comment.

type Engine = typeof oxc
const engines: [string, Engine][] = [
  ['oxc', oxc],
  ['acorn', acorn as Engine],
]

const execFileAsync = promisify(execFile)
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

for (const engineName of ['oxc', 'acorn']) {
  test(`${engineName} build mode: surviving pragmas still steer esbuild`, async (t) => {
    const outDir = await mkdtemp(join(tmpdir(), `wrap-esm-lambda-comments-${engineName}-`))
    try {
      const outfile = join(outDir, 'bundle.mjs')
      // esbuild runs in a child so the plugin's core import binds per engine
      const driver = `
        import { build } from 'esbuild'
        import { pathToFileURL } from 'node:url'
        const [entry, configPath, outfile] = process.argv.filter((a) => a !== '--').slice(-3)
        const { unplugin } = await import('@wrap-esm-lambda/unplugin')
        const { default: config } = await import(pathToFileURL(configPath).href)
        await build({
          entryPoints: [entry],
          bundle: true,
          format: 'esm',
          platform: 'node',
          outfile,
          plugins: [unplugin.esbuild(config)],
          logLevel: 'silent',
        })
      `
      await execFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          driver,
          '--',
          fixture('app-comments.mjs'),
          fixture('wrap.config.comments.mjs'),
          outfile,
        ],
        { env: { ...process.env, WRAP_ESM_LAMBDA_ENGINE: engineName } },
      )
      const bundled = await readFile(outfile, 'utf8')

      // the patch worked, so the module demonstrably took the rewrite path
      const { stdout } = await execFileAsync(process.execPath, [outfile])
      t.is(stdout.trim(), 'wrapped:hi:x')

      t.false(
        bundled.includes('PURE_DROPPED'),
        'the @__PURE__ call was tree-shaken — the annotation survived the rewrite',
      )
      t.true(bundled.includes('KEPT_MARKER'), 'control: the unannotated call is kept, so shaking was annotation-driven')
      t.true(bundled.includes('KEEP-LEGAL'), 'the legal comment reached the bundle')
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
}
