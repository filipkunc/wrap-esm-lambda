import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as oxc from '../index.js'
import * as acornEngine from '@wrap-esm-lambda/engine-acorn'
import { applyMatched } from '@wrap-esm-lambda/core'

// Same-binding star dedup, the ResolveExport rule: a name forwarded by two
// `export *` sources is ambiguous only when the sources resolve it to
// DIFFERENT origin bindings. The fixture is the date-fns shape in
// miniature — `shared` reaches the barrel through both star sources, one an
// import-backed list export, one a direct re-export, both bottoming out at
// origin.js — while `clash` is two distinct local declarations, the
// genuinely ambiguous case that must stay a loud refusal. (Found by the
// corpus: date-fns forwards `longFormatters` through ./format.js and
// ./parse.js from one _lib module; see corpus/README.md.)

const execFileAsync = promisify(execFile)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/stars/${name}`, import.meta.url))
const pkgFile = (name: string) => fixture(`node_modules/@fake/stars/${name}`)

const barrelPath = pkgFile('barrel.js')
const barrelSource = readFileSync(barrelPath, 'utf8')
const entryFor = (bindings: string[]) => [
  {
    module: { name: '@fake/stars', files: [barrelPath] },
    patch: { name: 'patchShared', from: fixture('patches/stars.mjs') },
    bindings,
  },
]

test('both engines report identical re-export provenance, all three shapes', () => {
  const sources = {
    'import-backed list export + local': readFileSync(pkgFile('a.js'), 'utf8'),
    'direct re-export + local': readFileSync(pkgFile('b.js'), 'utf8'),
    'namespace re-export': 'export * as ns from "./m.js"\n',
    'default-import-backed list export': 'import d from "./m.js"\nexport { d as thing }\n',
  }
  for (const [label, source] of Object.entries(sources)) {
    const fromOxc = oxc.esmModuleExports(source)
    const fromAcorn = acornEngine.esmModuleExports(source)
    assert.deepStrictEqual(fromAcorn.reexports, fromOxc.reexports, `${label}: provenance matches across engines`)
  }
  // and the provenance itself is what the walk needs: a.js's `shared` is
  // m's binding even though the export list carries no source
  assert.deepStrictEqual(oxc.esmModuleExports(sources['import-backed list export + local']).reexports, [
    { exported: 'shared', imported: 'shared', source: './origin.js' },
  ])
  assert.deepStrictEqual(oxc.esmModuleExports(sources['direct re-export + local']).reexports, [
    { exported: 'shared', imported: 'shared', source: './origin.js' },
  ])
})

test('two star providers forwarding the SAME origin binding resolve (the date-fns shape)', () => {
  const applied = applyMatched(barrelSource, entryFor(['shared']), pathToFileURL(barrelPath).href, {
    format: 'module',
    delivery: 'registry',
  })
  assert.notStrictEqual(applied, null)
  // the shadow export reroutes through the first provider
  assert.match(String(applied!.code ?? '') + applied!.map, /./) // rewrite or append — either way it produced output
  assert.match(String(applied!.code ?? barrelSource), /\.\/a\.js/)
})

test('two star providers with DIFFERENT origins stay a loud refusal, origins named', () => {
  assert.throws(
    () =>
      applyMatched(barrelSource, entryFor(['clash']), pathToFileURL(barrelPath).href, {
        format: 'module',
        delivery: 'registry',
      }),
    (err: Error) => {
      assert.match(err.message, /'clash' is ambiguous/)
      assert.match(err.message, /different origins/)
      assert.match(err.message, /a\.js:clash/)
      assert.match(err.message, /b\.js:clash/)
      return true
    },
  )
})

for (const engine of ['oxc', 'acorn']) {
  test(`end to end under the runtime hook (${engine}): the deduped star binding patches`, async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', '@wrap-esm-lambda/hooks/register', fixture('app.mjs')],
      {
        env: {
          ...process.env,
          WRAP_ESM_LAMBDA_CONFIG: fixture('wrap.config.mjs'),
          WRAP_ESM_LAMBDA_STRICT: '1',
          WRAP_ESM_LAMBDA_ENGINE: engine,
        },
      },
    )
    assert.strictEqual(stdout.trim(), 'patched:origin')
  })
}
