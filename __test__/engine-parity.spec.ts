import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureThrows } from './helpers'

import * as oxc from '../index.js'
// @ts-expect-error untyped workspace package
import * as acorn from '@wrap-esm-lambda/engine-acorn'

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
  const shapesDir = new URL('./fixtures/tap-shapes/node_modules/@fake/shapes', import.meta.url).pathname
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
    assert.strictEqual(fromAcorn, fromOxc, `engines agree on ${specifier}`)
    if (suffix === null) {
      assert.strictEqual(fromOxc, null, `${specifier} resolves nowhere`)
    } else {
      assert.ok(fromOxc !== null && fromOxc.endsWith(suffix), `${specifier} -> .../${suffix} (got ${fromOxc})`)
    }
  }
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

test('acorn chained map reaches the upstream original source', () => {
  // Simulate the tsc pipeline: handler.js with an upstream map back to
  // handler.ts — the wrap map must chain through it (same scenario as the
  // Rust test_chained_source_map).
  const originalTs = 'export const handler = async (event) => {\n\n\n  throw new Error("boom");\n};\n'
  // a no-match transform is a codegen round-trip: its output plays the
  // intermediate handler.js, its map the upstream handler.js -> handler.ts
  const upstreamRun = oxc.transformLambdaWithMapObject(originalTs, 'no_such_handler', 'noop', 'handler.ts')
  const upstream = upstreamRun.map!
  const { code, map } = (acorn as Engine).transformLambdaWithChainedMapObject(
    upstreamRun.code,
    'handler',
    'wrapper',
    'handler.js',
    upstream,
  )
  assert.ok(code.includes('wrapper('))
  const parsed = JSON.parse(map!)
  assert.deepStrictEqual(parsed.sources, ['handler.ts'])
  assert.ok(parsed.sourcesContent, 'chaining carries the original content over')
})

// The wrap transform, acorn side: same behavior contract as the Rust unit
// tests (test_var_transform, test_fn_transform, test_export_list,
// test_export_from), formatting kept from the source instead of regenerated.
test('acorn wrap: variable export wraps the initializer in place', () => {
  const source = 'export const handler = async function(event) {\n\treturn "Hi";\n}, other = 123;\n'
  const out = (acorn as Engine).transformLambda(source, 'handler', 'wrapper')
  assert.strictEqual(out, 'export const handler = wrapper(async function(event) {\n\treturn "Hi";\n}), other = 123;\n')
})

test('acorn wrap: function declaration becomes a wrapped const', () => {
  const out = (acorn as Engine).transformLambda(
    'export async function handler(event) {\n  return 1;\n}\n',
    'handler',
    'wrapper',
  )
  assert.strictEqual(out, 'export const handler = wrapper(async function (event) {\n  return 1;\n});\n')
})

test('acorn wrap: renamed list export wraps the local declaration', () => {
  const source = 'const x = 1;\nconst y = async (event) => "Hi";\nexport { x, y as z };\n'
  const out = (acorn as Engine).transformLambda(source, 'z', 'wrapper')
  assert.ok(out.includes('const y = wrapper(async (event) => "Hi");'))
  assert.ok(out.includes('export { x, y as z };'))
})

test('acorn wrap: re-export from another module imports and wraps the original', () => {
  const out = (acorn as Engine).transformLambda('export { handler } from "other.js";', 'handler', 'wrapper')
  assert.ok(out.includes('import { handler as orig_handler } from "other.js";'))
  assert.ok(out.includes('export const handler = wrapper(orig_handler);'))
})
