// The engine indirection: every transform call in core goes through this
// module, which binds to one of two implementations of the same surface —
//
// - 'oxc' (default): the native `wrap-esm-lambda` addon — oxc parse and
//   codegen in Rust, sources crossing napi (zero-copy for Buffers);
// - 'acorn': `@wrap-esm-lambda/engine-acorn` — acorn + magic-string, no
//   native code at all.
//
// The binding is process-wide (the runtime hook and a build both instrument
// every matched module with one engine) and LAZY: nothing loads until the
// first transform call actually needs an engine, so importing core — a
// config file pulling in `definePatches`, a shell whose config turns out
// inert — costs no engine at all. Only the selected engine ever loads; the
// unused one's cost (the addon's dlopen or the JS engine's module graph)
// never lands. Loading is `require()`-based — including `require(esm)` for
// the acorn engine (Node >= 22.12) — because the first use can sit inside a
// SYNCHRONOUS `registerHooks` load hook, where nothing can be awaited. The
// runtime shell still binds at startup when its config has anything to
// instrument (registerConfig calls `engineName()`), so a missing or
// mismatched explicitly-named engine stays a startup failure, not a
// per-module surprise.
//
// Both engines emit byte-identical snippets and share the tap contract
// (enforced by __test__/engine-parity.spec.ts); rewrite-path output differs
// in formatting only (oxc codegen regenerates, magic-string edits in place).
// `TransformEngine` below is that contract as a type, and the ENGINES map is
// declared to hold it — so a drift between the addon's generated
// `index.d.ts` and the acorn engine's exports is a build error now, not only
// a test failure. The types are written out here rather than imported from
// `wrap-esm-lambda` on purpose: the addon is an optional dependency, and
// core's own declarations have to stay resolvable without it.
//
// The default binding is also the one recovery path core takes on its own: a
// native addon that cannot be loaded (no prebuilt binary for the platform, a
// stripped container layer, npm's optional-dependency bug) degrades to the
// acorn engine with a warning rather than throwing out of `--import`. See
// engine-select.mts — an explicitly requested engine is never substituted.
import { createRequire } from 'node:module'
import { selectEngine } from './engine-select.mjs'
import { debug, warnOnce } from './diagnostics.mjs'

/**
 * One patch entry's inputs to the exports tap — mirrors the JS config entry.
 * `aliasIndex` keeps the injected import alias unique when several entries
 * patch the same module in import delivery.
 */
export interface TapEntryInput {
  bindings: string[]
  patchName: string
  patchFrom: string
  aliasIndex: number
}

/**
 * A resolution for a name forwarded by a bare `export * from`: `binding` is
 * (transitively) provided by the star source `source`.
 */
export interface TapStarResolution {
  binding: string
  source: string
}

/**
 * Result of the tap for one module (all its entries at once). `code == null`
 * is the append-only fast path — append `snippets` to the untouched source. A
 * non-null `code` is a module regenerated from its AST, with `map` the v3
 * source map of that rewrite.
 *
 * Both `undefined` and `null` are in the type on purpose: napi renders a Rust
 * `Option::None` as `undefined`, the JS engine returns `null`, and every
 * caller in core tests with `== null` — which is exactly why the two engines
 * were interchangeable before any of this was typed.
 */
export interface TapResult {
  snippets: string
  code?: string | null
  map?: string | null
}

/**
 * The statically visible surface of an ESM module: every exported name plus
 * the specifiers of bare `export * from` statements.
 */
export interface EsmExportsInfo {
  names: string[]
  starSources: string[]
}

/** The optional trailing arguments both tap variants share. */
type TapTail = [
  filename?: string | undefined | null,
  upstreamMap?: string | undefined | null,
  starResolutions?: TapStarResolution[] | undefined | null,
]

/**
 * The transform surface core depends on — implemented twice, once in Rust and
 * once in JavaScript, interchangeable at runtime.
 */
export interface TransformEngine {
  tapContractVersion(): number
  esmModuleExports(input: string): EsmExportsInfo
  exportsTap(input: string, entries: TapEntryInput[], cjs: boolean, registry: boolean, ...tail: TapTail): TapResult
  exportsTapFromBuffer(
    input: Buffer,
    entries: TapEntryInput[],
    cjs: boolean,
    registry: boolean,
    ...tail: TapTail
  ): TapResult
  hasModuleSyntax(input: string): boolean
  resolveModule(specifier: string, fromDir: string): string | null
}

const requireEngine = createRequire(import.meta.url)

// require(), not import(): binding may happen inside a synchronous load
// hook. The addon is CJS; the acorn engine is ESM without top-level await,
// which require() loads synchronously on the Nodes core supports.
const ENGINES: Record<string, () => TransformEngine> = {
  oxc: () => requireEngine('wrap-esm-lambda') as TransformEngine,
  acorn: () => requireEngine('@wrap-esm-lambda/engine-acorn') as TransformEngine,
}

/**
 * The transform contract core is written against: the emitted snippet shapes
 * and the tap surfaces. Both engines report their own; a mismatch means the
 * package range did not describe reality.
 *
 * It can happen: the addon is an OPTIONAL dependency resolved on the
 * consumer's machine, so a core installed alongside one addon version can end
 * up loaded next to another. A mismatch is worse than a missing addon —
 * instrumentation that emits plausible code and patches nothing — so it is
 * treated the same way, which for the default engine means degrading to the
 * pure-JS one rather than trusting it.
 */
// Version 2: the wrap transform left the contract — the engine surface is
// tap-only (the native addon still exports `transformLambda*`, but as
// standalone functions core never calls).
export const TAP_CONTRACT_VERSION = 2

function verifyContract(engine: TransformEngine): void {
  const reported = typeof engine.tapContractVersion === 'function' ? engine.tapContractVersion() : undefined
  if (reported !== TAP_CONTRACT_VERSION) {
    throw new Error(
      `transform contract mismatch: core expects ${TAP_CONTRACT_VERSION}, the engine reports ${String(reported)} ` +
        `— install a matching 'wrap-esm-lambda' addon version`,
    )
  }
}

let selected: { engineName: string; engine: TransformEngine } | undefined

/** Bind on first use, once per process; every transform call funnels here. */
function boundEngine(): TransformEngine {
  if (selected === undefined) {
    selected = selectEngine(process.env.WRAP_ESM_LAMBDA_ENGINE, ENGINES, {
      verify: verifyContract,
      onFallback: (err) => {
        const reason = err instanceof Error ? err.message : String(err)
        warnOnce(
          'engine',
          `the native oxc addon could not be used (${reason}) — falling back to the pure-JS acorn engine ` +
            `(WRAP_ESM_LAMBDA_ENGINE=oxc to fail instead)`,
        )
      },
    })
    debug(`engine: ${selected.engineName}`)
  }
  return selected.engine
}

/**
 * The engine this process is bound to: 'oxc' (native, default) or 'acorn'
 * (pure JS). Calling this BINDS the engine if nothing else has — which is
 * also its second job: the runtime shell calls it at register time so a
 * missing or mismatched engine fails at startup, not inside the first
 * module's synchronous load hook.
 */
export function engineName(): string {
  boundEngine()
  return selected!.engineName
}

export const esmModuleExports: TransformEngine['esmModuleExports'] = (input) => boundEngine().esmModuleExports(input)
export const exportsTap: TransformEngine['exportsTap'] = (...args) => boundEngine().exportsTap(...args)
export const exportsTapFromBuffer: TransformEngine['exportsTapFromBuffer'] = (...args) =>
  boundEngine().exportsTapFromBuffer(...args)
export const hasModuleSyntax: TransformEngine['hasModuleSyntax'] = (input) => boundEngine().hasModuleSyntax(input)
export const resolveModule: TransformEngine['resolveModule'] = (specifier, fromDir) =>
  boundEngine().resolveModule(specifier, fromDir)
