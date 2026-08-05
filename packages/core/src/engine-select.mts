// Engine selection, separated from the binding in engine.mjs so the fallback
// decision is testable without a broken native addon on hand.
//
// The native addon is prebuilt per platform, which means it can be absent for
// reasons that have nothing to do with the app: a platform with no published
// binary, a stripped container layer, an npm optional-dependency install bug.
// A pure-JS engine with the same transform surface already exists for exactly
// this trade-off study — so an unavailable addon degrades to it instead of
// throwing out of `--import` and taking the process down with it.
//
// An engine named EXPLICITLY is never substituted: `WRAP_ESM_LAMBDA_ENGINE=oxc`
// means "fail if the native addon is missing", which is what CI runs so a
// broken build can never masquerade as a passing acorn run.
//
// Availability is deliberately NOT tied to WRAP_ESM_LAMBDA_STRICT. Strict mode
// is a policy for instrumentation failures — a moved binding, a throwing patch
// — and someone who wants those loud should not thereby lose the pure-JS
// engine on a platform that has no prebuilt addon. WRAP_ESM_LAMBDA_ENGINE is
// the one lever over which engine is acceptable.

/** The engine used when the default one cannot be loaded. */
export const FALLBACK_ENGINE = 'acorn'

/** The engine bound when WRAP_ESM_LAMBDA_ENGINE is unset. */
const DEFAULT_ENGINE = 'oxc'

export interface SelectEngineOptions<Engine> {
  /** Called with the load failure just before the fallback is bound. */
  onFallback?: (err: unknown) => void
  /**
   * Checked against a freshly loaded engine; throwing rejects it exactly as a
   * failed import would, so an engine that loads but cannot be trusted (a
   * mismatched transform contract) degrades down the same path.
   */
  verify?: (engine: Engine) => void
}

/**
 * Synchronous on purpose: the first engine use can sit inside a synchronous
 * `registerHooks` load hook, where nothing can be awaited — so engine
 * loaders are `require()`-based (see engine.mts) and selection composes
 * with them synchronously.
 *
 * @param requested WRAP_ESM_LAMBDA_ENGINE, unset for the default
 * @param loaders engine name -> loader
 */
export function selectEngine<Engine>(
  requested: string | undefined,
  loaders: Record<string, () => Engine>,
  options: SelectEngineOptions<Engine> = {},
): { engineName: string; engine: Engine } {
  const { onFallback, verify } = options
  const explicit = requested !== undefined && requested !== ''
  const name = explicit ? requested : DEFAULT_ENGINE
  if (!Object.hasOwn(loaders, name)) {
    throw new Error(
      `wrap-esm-lambda: unknown engine '${name}' in WRAP_ESM_LAMBDA_ENGINE (expected ${Object.keys(loaders).join(' or ')})`,
    )
  }
  try {
    const engine = loaders[name]!()
    verify?.(engine)
    return { engineName: name, engine }
  } catch (err) {
    // An explicit request, or a failure of the fallback itself: nothing left
    // to degrade to, so this is the loud path.
    if (explicit || name === FALLBACK_ENGINE) {
      throw err
    }
    onFallback?.(err)
    try {
      const fallback = loaders[FALLBACK_ENGINE]
      if (fallback === undefined) throw err
      const engine = fallback()
      verify?.(engine)
      return { engineName: FALLBACK_ENGINE, engine }
    } catch (fallbackErr) {
      throw new Error(
        `wrap-esm-lambda: neither the '${name}' engine nor the '${FALLBACK_ENGINE}' fallback could be loaded`,
        { cause: new AggregateError([err, fallbackErr]) },
      )
    }
  }
}
