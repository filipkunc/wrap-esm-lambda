import test from 'ava'

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
  ['re-export split', 'export { Client, VERSION } from "./client.js";\n', ['Client']],
  ['default re-export split', 'export { default as Client } from "./client.js";\n', ['Client']],
  ['import-backed list export split', 'import { x } from "./dep.js";\nexport { x };\n', ['x']],
  ['default-import-backed split', 'import Client from "./client.js";\nexport { Client };\n', ['Client']],
  ['namespace re-export split', 'export * as ns from "./m.js";\n', ['ns']],
]

for (const [label, source, bindings] of SHAPES) {
  test(`both engines emit identical output: ${label}`, (t) => {
    for (const registry of [true, false]) {
      const fromOxc = tap(oxc, source, bindings, registry)
      const fromAcorn = tap(acorn as Engine, source, bindings, registry)
      t.is(fromAcorn.snippets, fromOxc.snippets, 'snippets are byte-identical')
      t.is(fromAcorn.code ?? null, fromOxc.code ?? null, 'rewrite output (or its absence) matches')
      t.is(fromAcorn.map == null, fromOxc.map == null, 'both engines agree on whether a map is emitted')
    }
  })
}

test('CJS mode: identical snippets, including module.exports rebinding and verified setters', (t) => {
  for (const bindings of [['Client'], ['module.exports'], ['Client', 'send']]) {
    const fromOxc = oxc.exportsTap('', [{ ...ENTRY, bindings }], true, true)
    const fromAcorn = (acorn as Engine).exportsTap('', [{ ...ENTRY, bindings }], true, true)
    t.is(fromAcorn.snippets, fromOxc.snippets)
    t.is(fromAcorn.code ?? null, null)
    t.is(fromOxc.code ?? null, null)
  }
})

test('multiple entries share rewrites identically across engines', (t) => {
  const source = 'export const VERSION = "1.0.0";\n'
  const entries = [
    { bindings: ['VERSION'], patchName: 'patchA', patchFrom: '/a.ts', aliasIndex: 0 },
    { bindings: ['VERSION'], patchName: 'patchB', patchFrom: '/b.ts', aliasIndex: 1 },
  ]
  const fromOxc = oxc.exportsTap(source, entries, false, false, 'mod.js')
  const fromAcorn = (acorn as Engine).exportsTap(source, entries, false, false, 'mod.js')
  t.is(fromAcorn.snippets, fromOxc.snippets)
  t.is(fromAcorn.code, fromOxc.code)
  t.is(fromAcorn.code!.match(/let VERSION/g)!.length, 1, 'both entries share one demotion')
})

test('star resolutions produce identical append-only stubs', (t) => {
  const source = 'export * from "./m.js";\n'
  const run = (engine: Engine) =>
    engine.exportsTap(source, [{ ...ENTRY, bindings: ['Hidden'] }], false, true, 'mod.js', undefined, [
      { binding: 'Hidden', source: './m.js' },
    ])
  const fromOxc = run(oxc)
  const fromAcorn = run(acorn as Engine)
  t.is(fromAcorn.snippets, fromOxc.snippets)
  t.is(fromAcorn.code ?? null, null, 'star shadowing stays append-only')
  t.is(fromOxc.code ?? null, null)
})

test('a missing export throws the same message from both engines', (t) => {
  const source = 'export * from "./m.js";\nexport class Client {}\nexport default 1;\n'
  const errors = engines.map(([, engine]) => t.throws(() => tap(engine, source, ['Hidden']))!.message)
  t.is(errors[1], errors[0])
  t.regex(errors[0], /export 'Hidden' not found in module/)
  t.regex(errors[0], /available: Client, default/)
  t.regex(errors[0], /unresolved 'export \*' sources: \.\/m\.js/)
})

test('esmModuleExports reports the same surface from both engines', (t) => {
  const source = 'export const a = 1;\nexport * from "./x.js";\nexport * as ns from "./y.js";\nexport default 2;\n'
  const fromOxc = oxc.esmModuleExports(source)
  const fromAcorn = (acorn as Engine).esmModuleExports(source)
  t.deepEqual(fromAcorn.names, fromOxc.names)
  t.deepEqual(fromAcorn.starSources, fromOxc.starSources)
  t.deepEqual(fromAcorn.starSources, ['./x.js'], 'only the bare star is a walk source')
})

test('acorn rewrite map: positions in untouched code resolve to the original source', async (t) => {
  const source = 'export const handler = async (event) => {\n  throw new Error("boom");\n};\n'
  const out = tap(acorn as Engine, source, ['handler'])
  t.truthy(out.map)
  const { TraceMap, originalPositionFor } = await import('@jridgewell/trace-mapping')
  const tracer = new TraceMap(JSON.parse(out.map!))
  // the throw sits on line 2 in both the original and the demoted module
  const original = originalPositionFor(tracer, { line: 2, column: 8 })
  t.is(original.source, 'mod.js')
  t.is(original.line, 2)
})

test('acorn chained map reaches the upstream original source', (t) => {
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
  t.true(code.includes('wrapper('))
  const parsed = JSON.parse(map!)
  t.deepEqual(parsed.sources, ['handler.ts'])
  t.truthy(parsed.sourcesContent, 'chaining carries the original content over')
})

// The wrap transform, acorn side: same behavior contract as the Rust unit
// tests (test_var_transform, test_fn_transform, test_export_list,
// test_export_from), formatting kept from the source instead of regenerated.
test('acorn wrap: variable export wraps the initializer in place', (t) => {
  const source = 'export const handler = async function(event) {\n\treturn "Hi";\n}, other = 123;\n'
  const out = (acorn as Engine).transformLambda(source, 'handler', 'wrapper')
  t.is(out, 'export const handler = wrapper(async function(event) {\n\treturn "Hi";\n}), other = 123;\n')
})

test('acorn wrap: function declaration becomes a wrapped const', (t) => {
  const out = (acorn as Engine).transformLambda(
    'export async function handler(event) {\n  return 1;\n}\n',
    'handler',
    'wrapper',
  )
  t.is(out, 'export const handler = wrapper(async function (event) {\n  return 1;\n});\n')
})

test('acorn wrap: renamed list export wraps the local declaration', (t) => {
  const source = 'const x = 1;\nconst y = async (event) => "Hi";\nexport { x, y as z };\n'
  const out = (acorn as Engine).transformLambda(source, 'z', 'wrapper')
  t.true(out.includes('const y = wrapper(async (event) => "Hi");'))
  t.true(out.includes('export { x, y as z };'))
})

test('acorn wrap: re-export from another module imports and wraps the original', (t) => {
  const out = (acorn as Engine).transformLambda('export { handler } from "other.js";', 'handler', 'wrapper')
  t.true(out.includes('import { handler as orig_handler } from "other.js";'))
  t.true(out.includes('export const handler = wrapper(orig_handler);'))
})
