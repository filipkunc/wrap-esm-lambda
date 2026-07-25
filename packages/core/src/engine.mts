// The engine indirection: every transform call in core goes through this
// module, which binds to one of two implementations of the same surface —
//
// - 'oxc' (default): the native `wrap-esm-lambda` addon — oxc parse and
//   codegen in Rust, sources crossing napi (zero-copy for Buffers);
// - 'acorn': `@wrap-esm-lambda/engine-acorn` — acorn + magic-string, no
//   native code at all.
//
// Selection is by WRAP_ESM_LAMBDA_ENGINE at load time, not per call: an
// engine is a process-wide choice (the runtime hook and a build both
// instrument every matched module with it), and binding once keeps the
// unused engine's load cost — the native addon's dlopen or the JS engine's
// module graph — entirely off the cold start.
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

/** Transformed code plus the raw v3 source map JSON of the transform. */
export interface TransformResult {
  code: string
  map?: string | null
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
  transformLambdaWithMapObject(input: string, handler: string, wrapper: string, filename: string): TransformResult
}

const ENGINES: Record<string, () => Promise<TransformEngine>> = {
  oxc: () => import('wrap-esm-lambda'),
  acorn: () => import('@wrap-esm-lambda/engine-acorn'),
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
export const TAP_CONTRACT_VERSION = 1

function verifyContract(engine: TransformEngine): void {
  const reported = typeof engine.tapContractVersion === 'function' ? engine.tapContractVersion() : undefined
  if (reported !== TAP_CONTRACT_VERSION) {
    throw new Error(
      `transform contract mismatch: core expects ${TAP_CONTRACT_VERSION}, the engine reports ${String(reported)} ` +
        `— install a matching 'wrap-esm-lambda' addon version`,
    )
  }
}

const selected = await selectEngine(process.env.WRAP_ESM_LAMBDA_ENGINE, ENGINES, {
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

/** The engine this process is bound to: 'oxc' (native, default) or 'acorn' (pure JS). */
export const engineName = selected.engineName

debug(`engine: ${engineName}`)

export const {
  esmModuleExports,
  exportsTap,
  exportsTapFromBuffer,
  hasModuleSyntax,
  resolveModule,
  transformLambdaWithMapObject,
} = selected.engine
