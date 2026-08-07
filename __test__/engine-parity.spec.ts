import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { captureThrows } from './helpers'

import * as oxc from '../index.js'
import * as acorn from '@wrap-esm-lambda/engine-acorn'
import { isMissingExportError } from '@wrap-esm-lambda/core'

// The two transform engines side by side: the native oxc addon (JS + Rust)
// and the pure-JS acorn engine. Their contract is shared — same API, same
// emitted snippets (byte-identical: both feed the same runtime registry and
// the same shells), same fast-path/rewrite split, same loud errors (core's
// star-retry matches on the message text). The rewrite path is where the
// implementations genuinely differ — oxc regenerates the module through
// codegen, acorn edits it in place with magic-string — yet on conventionally
// formatted sources even that output converges byte-for-byte, which these
// tests pin so the engines can never drift apart silently.

type Engine = typeof oxc
const engines: [string, Engine][] = [
  ['oxc', oxc],
  ['acorn', acorn as Engine],
]

const ENTRY = { bindings: ['x'], patchName: 'patchIt', patchFrom: '/abs/patch.ts', aliasIndex: 0 }
const tap = (engine: Engine, source: string, bindings: string[], registry = true) =>
  engine.exportsTap(source, [{ ...ENTRY, bindings }], false, registry, 'mod.js')

// Every export shape the tap handles, fast path and rewrite path alike.
const SHAPES: [string, string, string[]][] = [
  [
    'mutable class export (fast path)',
    'export class Client {\n\tsend(command) {\n\t\treturn command;\n\t}\n}\n',
    ['Client'],
  ],
  ['named default declaration (fast path)', 'export default class Hono {\n\troute(p) { return p; }\n}\n', ['default']],
  ['let destructuring (fast path)', 'export let { greet } = make();\n', ['greet']],
  ['const demotion', 'export const handler = async (event) => event;\n', ['handler']],
  ['list-exported const demotion', 'const y = async (e) => e;\nexport { y as handler };\n', ['handler']],
  ['destructured const demotion', 'export const { greet, meta: [info] } = make();\n', ['greet', 'info']],
  ['const pattern behind list export', 'const { a } = make();\nexport { a as alpha };\n', ['alpha']],
  ['anonymous default naming', 'export default async (event) => event;\n', ['default']],
  // ASI style: the created `let` must gain a terminator, or webpack's
  // statement removal fuses the template with the next expression into a
  // tagged-template call (caught by the webpack leg of bundlers.spec.ts)
  ['anonymous default naming (ASI, template)', 'export default async (event) => `dflt:${event}`\n', ['default']],
  ['re-export split', 'export { Client, VERSION } from "./client.js";\n', ['Client']],
  ['default re-export split', 'export { default as Client } from "./client.js";\n', ['Client']],
  ['import-backed list export split', 'import { x } from "./dep.js";\nexport { x };\n', ['x']],
  ['default-import-backed split', 'import Client from "./client.js";\nexport { Client };\n', ['Client']],
  ['namespace re-export split', 'export * as ns from "./m.js";\n', ['ns']],
]

for (const [label, source, bindings] of SHAPES) {
  test(`both engines emit identical output: ${label}`, () => {
    for (const registry of [true, false]) {
      const fromOxc = tap(oxc, source, bindings, registry)
      const fromAcorn = tap(acorn as Engine, source, bindings, registry)
      assert.strictEqual(fromAcorn.snippets, fromOxc.snippets, 'snippets are byte-identical')
      assert.strictEqual(fromAcorn.code ?? null, fromOxc.code ?? null, 'rewrite output (or its absence) matches')
      assert.strictEqual(fromAcorn.map == null, fromOxc.map == null, 'both engines agree on whether a map is emitted')
    }
  })
}

test('CJS mode: identical snippets, including module.exports rebinding and verified setters', () => {
  for (const bindings of [['Client'], ['module.exports'], ['Client', 'send']]) {
    const fromOxc = oxc.exportsTap('', [{ ...ENTRY, bindings }], true, true)
    const fromAcorn = (acorn as Engine).exportsTap('', [{ ...ENTRY, bindings }], true, true)
    assert.strictEqual(fromAcorn.snippets, fromOxc.snippets)
    assert.strictEqual(fromAcorn.code ?? null, null)
    assert.strictEqual(fromOxc.code ?? null, null)
  }
})

test('CJS import delivery: identical require() snippets — never an ESM import into CJS', () => {
  for (const bindings of [['Client'], ['module.exports']]) {
    const fromOxc = oxc.exportsTap('', [{ ...ENTRY, bindings }], true, false)
    const fromAcorn = (acorn as Engine).exportsTap('', [{ ...ENTRY, bindings }], true, false)
    assert.strictEqual(fromAcorn.snippets, fromOxc.snippets, 'snippets are byte-identical')
    assert.ok(fromOxc.snippets.includes('const { patchIt: __wel_patch_0 } = require("/abs/patch.ts");'))
    assert.ok(!fromOxc.snippets.includes('import {'), 'an import would flip the CJS module format under bundlers')
  }
})

test('resolveModule: both engines resolve import-style, byte-identical paths', () => {
  // The star walk's resolver: oxc_resolver natively, its JS twin in the
  // acorn engine. Pinned on the fixture shapes that matter — an exports map
  // under the `import` condition, a map-less `"module"`-before-`"main"`
  // package, a relative file, and a specifier that resolves nowhere.
  // fileURLToPath, not URL#pathname: on Windows the latter yields
  // '/C:/...', which no resolver on either side can start a walk from
  const shapesDir = fileURLToPath(new URL('./fixtures/tap-shapes/node_modules/@fake/shapes', import.meta.url))
  const cases: [string, string | null][] = [
    ['@fake/star-pkg', 'star-pkg/esm/index.js'],
    ['@fake/star-plain', 'star-plain/esm.js'],
    ['./star-mid.js', 'shapes/star-mid.js'],
    ['@fake/not-installed', null],
    ['node:path', null],
  ]
  for (const [specifier, suffix] of cases) {
    const fromOxc = oxc.resolveModule(specifier, shapesDir)
    const fromAcorn = (acorn as Engine).resolveModule(specifier, shapesDir)
    // byte-identical between engines is the actual contract, on every platform
    assert.strictEqual(fromAcorn, fromOxc, `engines agree on ${specifier}`)
    if (suffix === null) {
      assert.strictEqual(fromOxc, null, `${specifier} resolves nowhere`)
    } else {
      // the expected suffixes are written '/'-separated; both resolvers answer
      // in the platform's separators (backslashes on Windows)
      const resolved = fromOxc === null ? null : fromOxc.replaceAll('\\', '/')
      assert.ok(resolved !== null && resolved.endsWith(suffix), `${specifier} -> .../${suffix} (got ${fromOxc})`)
    }
  }
})

test('both engines report the transform contract version core expects', async () => {
  // The number core checks at bind time. Emitted snippet shapes and the tap
  // surfaces are what it stands for, so it belongs with the tests that diff
  // those two things — and it must be bumped in three places at once or this
  // fails, which is the point.
  const core = await import('@wrap-esm-lambda/core')
  assert.strictEqual(oxc.tapContractVersion(), core.TAP_CONTRACT_VERSION, 'native addon')
  assert.strictEqual((acorn as Engine).tapContractVersion(), core.TAP_CONTRACT_VERSION, 'acorn engine')
})

test('hasModuleSyntax: both engines answer the CJS-or-ESM syntax question identically', () => {
  const cases: [string, boolean][] = [
    ['export const x = 1;\n', true],
    ['import x from "y";\n', true],
    ['console.log(import.meta.url);\n', true],
    ['const lib = require("./lib");\nexports = module.exports = lib;\nexports.json = () => {};\n', false],
    // dynamic import is valid in CJS too — not module syntax
    ['import("x").then(() => {});\n', false],
    // does not parse as ESM at all -> whatever it is, the ESM tap cannot read it
    ['with (obj) { x = 1; }\n', false],
  ]
  for (const [source, expected] of cases) {
    assert.strictEqual(oxc.hasModuleSyntax(source), expected, `oxc on ${JSON.stringify(source)}`)
    assert.strictEqual((acorn as Engine).hasModuleSyntax(source), expected, `acorn on ${JSON.stringify(source)}`)
  }
})

test('multiple entries share rewrites identically across engines', () => {
  const source = 'export const VERSION = "1.0.0";\n'
  const entries = [
    { bindings: ['VERSION'], patchName: 'patchA', patchFrom: '/a.ts', aliasIndex: 0 },
    { bindings: ['VERSION'], patchName: 'patchB', patchFrom: '/b.ts', aliasIndex: 1 },
  ]
  const fromOxc = oxc.exportsTap(source, entries, false, false, 'mod.js')
  const fromAcorn = (acorn as Engine).exportsTap(source, entries, false, false, 'mod.js')
  assert.strictEqual(fromAcorn.snippets, fromOxc.snippets)
  assert.strictEqual(fromAcorn.code, fromOxc.code)
  assert.strictEqual(fromAcorn.code!.match(/let VERSION/g)!.length, 1, 'both entries share one demotion')
})

test('star resolutions produce identical append-only stubs', () => {
  const source = 'export * from "./m.js";\n'
  const run = (engine: Engine) =>
    engine.exportsTap(source, [{ ...ENTRY, bindings: ['Hidden'] }], false, true, 'mod.js', undefined, [
      { binding: 'Hidden', source: './m.js' },
    ])
  const fromOxc = run(oxc)
  const fromAcorn = run(acorn as Engine)
  assert.strictEqual(fromAcorn.snippets, fromOxc.snippets)
  assert.strictEqual(fromAcorn.code ?? null, null, 'star shadowing stays append-only')
  assert.strictEqual(fromOxc.code ?? null, null)
})

test('a missing export throws the same message from both engines', () => {
  const source = 'export * from "./m.js";\nexport class Client {}\nexport default 1;\n'
  const errors = engines.map(([, engine]) => captureThrows(() => tap(engine, source, ['Hidden'])).message)
  assert.strictEqual(errors[1], errors[0])
  assert.match(errors[0], /export 'Hidden' not found in module/)
  assert.match(errors[0], /available: Client, default/)
  assert.match(errors[0], /unresolved 'export \*' sources: \.\/m\.js/)
})

test("both engines' missing-export errors satisfy core's contract predicate", () => {
  // isMissingExportError is what tapWithStarRetry keys the star-graph retry
  // on. This is the drift alarm for that contract: each engine's ACTUAL
  // error object must pass the ACTUAL predicate, so rewording either
  // producer (rewrite.rs, tap.mts) or the predicate fails here instead of
  // silently disabling star resolution in production.
  const source = 'export class Client {}\n'
  for (const [name, engine] of engines) {
    const err = captureThrows(() => tap(engine, source, ['Hidden']))
    assert.strictEqual(isMissingExportError(err), true, `${name} error is recognized by isMissingExportError`)
  }
  assert.strictEqual(isMissingExportError(new Error('some other failure')), false, 'unrelated errors do not retry')
})

// The privates bridge (docs/design-private-bindings.md): the native engine
// grafts the member into the class AST and regenerates through codegen; the
// acorn engine prints the identical text by hand and splices it in. On
// codegen-conventional sources the two whole-module rewrites must stay
// byte-for-byte identical — this is the suite the design said would drive
// the port, and what any future TAP_CONTRACT_VERSION bump for `privates`
// will lean on.
const PRIVATES_SOURCE = `export class Db {
	#url;
	#pool = [];
	constructor(url) {
		this.#url = url;
	}
}
`
const privatesEntry = (privates: Record<string, string[]>, bindings = ['Db']) => [
  { bindings, patchName: 'traceDb', patchFrom: '/abs/apm-patch.mjs', aliasIndex: 0, privates },
]

test('privates bridge: both engines emit identical rewrites', () => {
  for (const registry of [true, false]) {
    const fromOxc = oxc.exportsTap(PRIVATES_SOURCE, privatesEntry({ Db: ['#url', '#pool'] }), false, registry, 'db.mjs')
    const fromAcorn = (acorn as Engine).exportsTap(
      PRIVATES_SOURCE,
      privatesEntry({ Db: ['#url', '#pool'] }),
      false,
      registry,
      'db.mjs',
    )
    assert.strictEqual(fromAcorn.snippets, fromOxc.snippets, 'snippets are byte-identical')
    assert.ok(fromOxc.code != null, 'a planned bridge forces the rewrite path')
    assert.strictEqual(fromAcorn.code, fromOxc.code, 'the injected member and the rest of the module match')
    assert.strictEqual(fromAcorn.map == null, fromOxc.map == null, 'both engines agree on whether a map is emitted')
  }
})

test('privates bridge: slot shapes emit identically (fields, methods, lone accessors, static)', () => {
  const source = `export class Shape {
	#hidden = 1;
	static #count = 7;
	#bump() {
		return ++this.#hidden;
	}
	get #virtual() {
		return this.#hidden * 2;
	}
	set #input(v) {
		this.#hidden = v;
	}
}
`
  // single-slot and multi-slot bridges format differently (codegen keeps a
  // one-property object inline) — pin each shape
  const requests: string[][] = [
    ['#hidden'],
    ['#bump'],
    ['#input'],
    ['#hidden', '#count', '#bump', '#virtual', '#input'],
  ]
  for (const names of requests) {
    const fromOxc = oxc.exportsTap(source, privatesEntry({ Shape: names }, ['Shape']), false, true, 'shape.mjs')
    const fromAcorn = (acorn as Engine).exportsTap(
      source,
      privatesEntry({ Shape: names }, ['Shape']),
      false,
      true,
      'shape.mjs',
    )
    assert.strictEqual(fromAcorn.code, fromOxc.code, `identical rewrite for privates [${names.join(', ')}]`)
  }
})

test('privates bridge: injection composes identically with a binding rewrite', () => {
  // a class-valued const: the demotion and the injection land in one rewrite
  const source = `export const Client = class {
	#token = "t0";
};
`
  const fromOxc = oxc.exportsTap(source, privatesEntry({ Client: ['#token'] }, ['Client']), false, true, 'client.mjs')
  const fromAcorn = (acorn as Engine).exportsTap(
    source,
    privatesEntry({ Client: ['#token'] }, ['Client']),
    false,
    true,
    'client.mjs',
  )
  assert.ok(fromOxc.code!.includes('export let Client'), 'the demotion happened')
  assert.strictEqual(fromAcorn.code, fromOxc.code)
})

test('privates refusals: identical messages, never the missing-export phrase', () => {
  const cases: [string, () => unknown][][] = engines.map(([, engine]) => [
    ['unknown class', () => engine.exportsTap(PRIVATES_SOURCE, privatesEntry({ Missing: ['#x'] }), false, true)],
    ['unknown private', () => engine.exportsTap(PRIVATES_SOURCE, privatesEntry({ Db: ['#nope'] }), false, true)],
    ['cjs', () => engine.exportsTap('', privatesEntry({ Db: ['#url'] }), true, true)],
  ])
  const [oxcCases, acornCases] = [cases[0]!, cases[1]!]
  for (let i = 0; i < oxcCases.length; i += 1) {
    const [label, runOxc] = oxcCases[i]!
    const [, runAcorn] = acornCases[i]!
    const fromOxc = captureThrows(() => runOxc())
    const fromAcorn = captureThrows(() => runAcorn())
    assert.strictEqual(fromAcorn.message, fromOxc.message, `${label}: identical message`)
    assert.strictEqual(isMissingExportError(fromOxc), false, `${label}: must never trigger core's star-graph retry`)
  }
})

test('esmModuleExports reports the same surface from both engines', () => {
  const source = 'export const a = 1;\nexport * from "./x.js";\nexport * as ns from "./y.js";\nexport default 2;\n'
  const fromOxc = oxc.esmModuleExports(source)
  const fromAcorn = (acorn as Engine).esmModuleExports(source)
  assert.deepStrictEqual(fromAcorn.names, fromOxc.names)
  assert.deepStrictEqual(fromAcorn.starSources, fromOxc.starSources)
  assert.deepStrictEqual(fromAcorn.starSources, ['./x.js'], 'only the bare star is a walk source')
})

test('acorn rewrite map: positions in untouched code resolve to the original source', async () => {
  const source = 'export const handler = async (event) => {\n  throw new Error("boom");\n};\n'
  const out = tap(acorn as Engine, source, ['handler'])
  assert.ok(out.map)
  const { TraceMap, originalPositionFor } = await import('@jridgewell/trace-mapping')
  const tracer = new TraceMap(JSON.parse(out.map!))
  // the throw sits on line 2 in both the original and the demoted module
  const original = originalPositionFor(tracer, { line: 2, column: 8 })
  assert.strictEqual(original.source, 'mod.js')
  assert.strictEqual(original.line, 2)
})
