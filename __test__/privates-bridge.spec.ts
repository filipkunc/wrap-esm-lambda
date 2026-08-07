import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as oxc from '../index.js'
import * as acornEngine from '@wrap-esm-lambda/engine-acorn'
import { isMissingExportError } from '@wrap-esm-lambda/core'
import { captureThrows } from './helpers'

// The privates bridge (docs/design-private-bindings.md), end to end on BOTH
// engines: `privates: { Db: ['#url'] }` injects a static block into the
// class body — the one place the private brand is legal — publishing
// get/set closures under Symbol.for('wrap-esm-lambda.privates'). Every
// behavioral test here runs per engine: the transformed module actually
// evaluates and the bridge operates on genuine branded instances. The
// byte-level parity of the two engines' emissions is pinned separately in
// engine-parity.spec.ts.

type Engine = typeof oxc
const engines: [string, Engine][] = [
  ['oxc', oxc],
  ['acorn', acornEngine as Engine],
]

const BRIDGE = Symbol.for(acornEngine.PRIVATE_BRIDGE_KEY)
const ENTRY = { bindings: ['Db'], patchName: 'traceDb', patchFrom: '/abs/apm-patch.mjs', aliasIndex: 0 }

const tapPrivates = (
  engine: Engine,
  source: string,
  privates: Record<string, string[]>,
  bindings = ['Db'],
): ReturnType<Engine['exportsTap']> =>
  engine.exportsTap(source, [{ ...ENTRY, bindings, privates }], false, true, 'db.mjs')

// registry delivery with no registry installed: the appended snippet no-ops,
// so the assembled module (rewritten code + snippets) is self-contained. The
// scratch dir lives inside the repo, not the OS tmpdir: this process runs
// under the oxc-node loader, whose instrumented output must resolve
// '@oxc-node/core' from wherever the module evaluates.
const workDir = await mkdtemp(join(fileURLToPath(new URL('./', import.meta.url)), 'privates-tmp-'))
after(() => rm(workDir, { recursive: true, force: true }))
let moduleCount = 0
const importModule = async (code: string): Promise<Record<string, any>> => {
  const file = join(workDir, `mod-${moduleCount++}.mjs`)
  await writeFile(file, code)
  return import(pathToFileURL(file).href)
}

// codegen-conventional formatting (tabs, semicolons): the same fixture
// feeds both engines, so the byte-level expectations of the parity suite
// hold here too
const DB_SOURCE = `export class Db {
	#url;
	#pool = [];
	constructor(url) {
		this.#url = url;
	}
	describe() {
		return \`db:\${this.#url}:\${this.#pool.length}\`;
	}
}
export function connect(url) {
	return new Db(url);
}
`

for (const [engineName, engine] of engines) {
  test(`${engineName}: the bridge grants real get/set on genuine instances`, async () => {
    const out = tapPrivates(engine, DB_SOURCE, { Db: ['#url', '#pool'] })
    assert.ok(out.code != null, 'a planned bridge forces the rewrite path even when bindings alone would not')
    const mod = await importModule(out.code! + out.snippets)
    const instance = new mod.Db('postgres://one')
    const bridge = mod.Db[BRIDGE]
    assert.strictEqual(bridge['#url'].get(instance), 'postgres://one')
    bridge['#url'].set(instance, 'postgres://two')
    assert.strictEqual(instance.describe(), 'db:postgres://two:0', 'the write landed in the real private field')
    bridge['#pool'].get(instance).push('conn')
    assert.strictEqual(instance.describe(), 'db:postgres://two:1')
  })

  test(`${engineName}: the bridge is symbol-keyed and invisible to enumerating reflection`, async () => {
    const out = tapPrivates(engine, DB_SOURCE, { Db: ['#url'] })
    const mod = await importModule(out.code! + out.snippets)
    const descriptor = Object.getOwnPropertyDescriptor(mod.Db, BRIDGE)
    assert.ok(descriptor, 'the bridge is an own property of the class')
    assert.strictEqual(descriptor!.enumerable, false)
    assert.strictEqual(descriptor!.writable, false)
    assert.strictEqual(descriptor!.configurable, false)
    // spread and Object.assign copy enumerable symbol keys — the bridge must
    // not ride along when statics are cloned onto some wrapper object
    assert.strictEqual(({ ...mod.Db } as Record<symbol, unknown>)[BRIDGE], undefined)
  })

  test(`${engineName}: the full patch pattern — subclass wrapper reads privates through the inherited bridge`, async () => {
    const seen: string[] = []
    const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for('wrap-esm-lambda.patches')] ??=
      Object.create(null)) as Record<string, unknown>
    registry['/abs/apm-patch.mjs#traceDb'] = (bindings: { Db: any }) => {
      const Original = bindings.Db
      const bridge = Original[BRIDGE]
      bindings.Db = class Db extends Original {
        constructor(...args: unknown[]) {
          super(...args)
          seen.push(bridge['#url'].get(this))
        }
      }
    }
    try {
      const out = tapPrivates(engine, DB_SOURCE, { Db: ['#url'] })
      const mod = await importModule(out.code! + out.snippets)
      // the library's own `new Db(...)` site constructs through the live
      // binding, so the wrapper intercepts — and its `this` carries the brand
      // (super() ran the original constructor), so the bridge just works
      const db = mod.connect('postgres://internal')
      assert.deepStrictEqual(seen, ['postgres://internal'])
      assert.ok(db instanceof mod.Db)
      assert.strictEqual(mod.Db[BRIDGE]['#url'].get(db), 'postgres://internal', 'the wrapper inherits the bridge')
    } finally {
      delete registry['/abs/apm-patch.mjs#traceDb']
    }
  })

  test(`${engineName}: slot shapes follow what the language permits`, async () => {
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
    const out = tapPrivates(engine, source, { Shape: ['#hidden', '#count', '#bump', '#virtual', '#input'] }, ['Shape'])
    const mod = await importModule(out.code! + out.snippets)
    const bridge = mod.Shape[BRIDGE]
    const shape = new mod.Shape()
    assert.deepStrictEqual(Object.keys(bridge['#hidden']), ['get', 'set'], 'a field grants both sides')
    assert.deepStrictEqual(Object.keys(bridge['#bump']), ['get'], 'a private method grants no setter')
    assert.deepStrictEqual(Object.keys(bridge['#virtual']), ['get'], 'a get-only accessor grants no setter')
    assert.deepStrictEqual(Object.keys(bridge['#input']), ['set'], 'a set-only accessor grants no getter')
    assert.strictEqual(bridge['#virtual'].get(shape), 2)
    bridge['#input'].set(shape, 5)
    assert.strictEqual(bridge['#hidden'].get(shape), 5)
    assert.strictEqual(bridge['#bump'].get(shape).call(shape), 6, 'the method getter returns the callable')
    // a static private's receiver is the class itself — same closures
    assert.strictEqual(bridge['#count'].get(mod.Shape), 7)
    bridge['#count'].set(mod.Shape, 8)
    assert.strictEqual(bridge['#count'].get(mod.Shape), 8)
  })

  test(`${engineName}: a class-valued const gets the bridge and the demotion in one rewrite`, async () => {
    const source = `export const Client = class {
	#token = "t0";
	whoami() {
		return this.#token;
	}
};
`
    const out = tapPrivates(engine, source, { Client: ['#token'] }, ['Client'])
    assert.ok(out.code!.includes('export let Client'), 'the const demotion still happens alongside the injection')
    const mod = await importModule(out.code! + out.snippets)
    const client = new mod.Client()
    mod.Client[BRIDGE]['#token'].set(client, 't1')
    assert.strictEqual(client.whoami(), 't1')
  })

  test(`${engineName}: entries bridging the same class converge on one injected static block`, () => {
    const entries = [
      { bindings: ['Db'], patchName: 'a', patchFrom: '/a.mjs', aliasIndex: 0, privates: { Db: ['#url'] } },
      { bindings: ['Db'], patchName: 'b', patchFrom: '/b.mjs', aliasIndex: 1, privates: { Db: ['#pool', '#url'] } },
    ]
    const out = engine.exportsTap(DB_SOURCE, entries, false, true, 'db.mjs')
    assert.strictEqual(out.code!.match(/wrap-esm-lambda\.privates/g)!.length, 1, 'one bridge member')
    assert.strictEqual(out.code!.match(/"#url": \{/g)!.length, 1, 'overlapping names dedupe')
    assert.ok(out.code!.includes('"#pool": {'), 'the union of names is bridged')
  })

  test(`${engineName}: without privates the fast path is untouched`, () => {
    const out = engine.exportsTap(DB_SOURCE, [{ ...ENTRY }], false, true, 'db.mjs')
    assert.strictEqual(out.code ?? null, null, 'a mutable class export still needs no rewrite')
  })

  test(`${engineName}: refusals are loud, validation-shaped, and never impersonate a missing export`, () => {
    const noClass = captureThrows(() => tapPrivates(engine, DB_SOURCE, { Missing: ['#x'] }))
    assert.match(noClass.message, /privates: no top-level class named 'Missing'/)
    assert.match(noClass.message, /top-level classes: Db/)
    assert.strictEqual(isMissingExportError(noClass), false, "must not trigger core's star-graph retry")

    const noPrivate = captureThrows(() => tapPrivates(engine, DB_SOURCE, { Db: ['#nope'] }))
    assert.match(noPrivate.message, /privates: '#nope' not found in class 'Db'/)
    assert.match(noPrivate.message, /available: #url, #pool/)
    assert.strictEqual(isMissingExportError(noPrivate), false)

    const cjs = captureThrows(() =>
      engine.exportsTap('', [{ ...ENTRY, privates: { Db: ['#url'] } }], true, true, 'db.cjs'),
    )
    assert.match(cjs.message, /privates: only ESM modules are supported/)
  })

  test(`${engineName}: the rewrite map still resolves positions across the injection`, async () => {
    const out = tapPrivates(engine, DB_SOURCE, { Db: ['#url'] })
    assert.ok(out.map)
    const { TraceMap, originalPositionFor } = await import('@jridgewell/trace-mapping')
    const tracer = new TraceMap(JSON.parse(out.map!))
    const lines = out.code!.split('\n')
    const connectLine = lines.findIndex((line) => line.includes('export function connect')) + 1
    const originalLine = DB_SOURCE.split('\n').findIndex((line) => line.includes('export function connect')) + 1
    assert.ok(connectLine > originalLine, 'sanity: the injection shifted later lines down')
    const original = originalPositionFor(tracer, { line: connectLine, column: 0 })
    assert.strictEqual(original.source, 'db.mjs')
    assert.strictEqual(original.line, originalLine, 'a line after the injected block maps back to its source line')
  })
}
