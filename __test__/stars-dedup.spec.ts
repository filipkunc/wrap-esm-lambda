import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
//
// The native addon is loaded dynamically so this spec also runs on the
// JS-only fallback lane (no addon built): the acorn legs always run — that
// lane is exactly where they matter — and the oxc legs skip with a reason.

type Engine = typeof acornEngine
let oxc: Engine | null = null
try {
  oxc = (await import('../index.js')) as unknown as Engine
} catch {
  // no native binding on this lane — acorn-only coverage below
}

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

const PROVENANCE_SHAPES: [string, string, { exported: string; imported: string; source: string }[]][] = [
  [
    'import-backed list export + local',
    readFileSync(pkgFile('a.js'), 'utf8'),
    [{ exported: 'shared', imported: 'shared', source: './origin.js' }],
  ],
  [
    'direct re-export + local',
    readFileSync(pkgFile('b.js'), 'utf8'),
    [{ exported: 'shared', imported: 'shared', source: './origin.js' }],
  ],
  ['namespace re-export', 'export * as ns from "./m.js"\n', [{ exported: 'ns', imported: '*', source: './m.js' }]],
  [
    'default-import-backed list export',
    'import d from "./m.js"\nexport { d as thing }\n',
    [{ exported: 'thing', imported: 'default', source: './m.js' }],
  ],
]

test('acorn reports the expected re-export provenance, all shapes', () => {
  for (const [label, source, expected] of PROVENANCE_SHAPES) {
    assert.deepStrictEqual(acornEngine.esmModuleExports(source).reexports, expected, label)
  }
})

test('the engines agree on provenance', { skip: oxc === null ? 'native addon not built on this lane' : false }, () => {
  for (const [label, source] of PROVENANCE_SHAPES) {
    assert.deepStrictEqual(
      oxc!.esmModuleExports(source).reexports,
      acornEngine.esmModuleExports(source).reexports,
      `${label}: provenance matches across engines`,
    )
  }
})

test('two star providers forwarding the SAME origin binding resolve (the date-fns shape)', () => {
  const applied = applyMatched(barrelSource, entryFor(['shared']), pathToFileURL(barrelPath).href, {
    format: 'module',
    delivery: 'registry',
  })
  assert.notStrictEqual(applied, null)
  // the shadow export reroutes through the first provider
  assert.match(String(applied!.code ?? barrelSource), /\.\/a\.js/)
})

test('a cyclic star graph terminates and resolves names reached through the cycle', () => {
  // barrel -> cycle-a -> cycle-b -> cycle-a. The walk memoizes each
  // module's provided-name set to stay O(sources + names), so the cycle is
  // where a memoizing traversal can hang or lose names. This pins
  // termination and that a name only reachable by stepping INTO the cycle
  // (`fromB`) still resolves. It deliberately does not claim to exercise
  // the "never cache a truncated set" guard in providedNames: in a plain
  // star cycle the truncated module is reachable through the branch that
  // completed it, so that guard is conservative rather than observable.
  const cyclicPath = pkgFile('cyclic-barrel.js')
  const cyclicSource = readFileSync(cyclicPath, 'utf8')
  for (const binding of ['fromA', 'fromB']) {
    const applied = applyMatched(
      cyclicSource,
      [
        {
          module: { name: '@fake/stars', files: [cyclicPath] },
          patch: { name: 'patchShared', from: fixture('patches/stars.mjs') },
          bindings: [binding],
        },
      ],
      pathToFileURL(cyclicPath).href,
      { format: 'module', delivery: 'registry' },
    )
    assert.notStrictEqual(applied, null, `${binding} resolves through the cycle`)
    assert.match(String(applied!.code ?? cyclicSource), /cycle-a\.js/)
  }
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
  test(
    `end to end under the runtime hook (${engine}): the deduped star binding patches`,
    { skip: engine === 'oxc' && oxc === null ? 'native addon not built on this lane' : false },
    async () => {
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
    },
  )
}
