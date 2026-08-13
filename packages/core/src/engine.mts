// Lazy, process-wide binding to one of two implementations of the same
// synchronous transform contract. The native engine falls back to Acorn only
// when it was not selected explicitly.
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

/** One re-exported name with its provenance: `exported` is the
 * consumer-visible name, `imported` the name taken from `source` (`*` for a
 * namespace re-export, `default` for a default import). Emitted for
 * explicit re-exports, namespace re-exports and list exports of
 * import-backed locals — the shapes whose binding lives in another module. */
export interface EsmReexport {
  exported: string
  imported: string
  source: string
}

/**
 * The statically visible surface of an ESM module: every exported name plus
 * the specifiers of bare `export * from` statements, and the provenance of
 * every export that resolves into another module. `reexports` is optional
 * only for engine-version tolerance (an older prebuilt addon omits it);
 * without it the star walk keeps its conservative provider-count refusal.
 */
export interface EsmExportsInfo {
  names: string[]
  starSources: string[]
  reexports?: EsmReexport[]
}

/**
 * Is this the tap's missing-export error? The phrase is part of the tap
 * contract: both engines throw `export '<name>' not found in module
 * (available: ...)` — produced independently in the addon's
 * `src/transform/rewrite.rs` and the acorn engine's `tap.mts` — and
 * `tapWithStarRetry` keys the star-graph retry on recognizing it here.
 * This predicate is the ONLY consumer-side match; the engine-parity suite
 * feeds both engines' actual errors through it, so rewording a producer
 * fails a test instead of silently disabling star resolution.
 */
export function isMissingExportError(err: unknown): boolean {
  return /not found in module/.test(err instanceof Error ? err.message : String(err))
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
  resolveStarBindings?(missing: string[], starSources: string[], modulePath: string): TapStarResolution[]
}

const requireEngine = createRequire(import.meta.url)

// require(), not import(): binding may happen inside a synchronous load
// hook. The addon is CJS; the acorn engine is ESM without top-level await,
// which require() loads synchronously on the Nodes core supports.
const ENGINES: Record<string, () => TransformEngine> = {
  oxc: () => requireEngine('@wrap-esm-lambda/engine-oxc') as TransformEngine,
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
        `— install matching '@wrap-esm-lambda/engine-oxc' and core versions`,
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

/** Native engines can keep the complete star graph walk on their side of the boundary. */
export function engineStarBindings(
  missing: string[],
  starSources: string[],
  modulePath: string,
): TapStarResolution[] | undefined {
  return boundEngine().resolveStarBindings?.(missing, starSources, modulePath)
}
