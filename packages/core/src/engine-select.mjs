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

/**
 * @param {string | undefined} requested WRAP_ESM_LAMBDA_ENGINE, unset for the default
 * @param {Record<string, () => Promise<unknown>>} loaders engine name -> importer
 * @param {{ defaultEngine?: string, onFallback?: (err: unknown) => void }} [options]
 * @returns {Promise<{ engineName: string, engine: any }>}
 */
export async function selectEngine(requested, loaders, options = {}) {
  const { defaultEngine = 'oxc', onFallback } = options
  const explicit = requested !== undefined && requested !== ''
  const name = explicit ? requested : defaultEngine
  if (!Object.hasOwn(loaders, name)) {
    throw new Error(
      `wrap-esm-lambda: unknown engine '${name}' in WRAP_ESM_LAMBDA_ENGINE (expected ${Object.keys(loaders).join(' or ')})`,
    )
  }
  try {
    return { engineName: name, engine: await loaders[name]() }
  } catch (err) {
    // An explicit request, or a failure of the fallback itself: nothing left
    // to degrade to, so this is the loud path.
    if (explicit || name === FALLBACK_ENGINE) {
      throw err
    }
    onFallback?.(err)
    try {
      return { engineName: FALLBACK_ENGINE, engine: await loaders[FALLBACK_ENGINE]() }
    } catch (fallbackErr) {
      throw new Error(
        `wrap-esm-lambda: neither the '${name}' engine nor the '${FALLBACK_ENGINE}' fallback could be loaded`,
        { cause: new AggregateError([err, fallbackErr]) },
      )
    }
  }
}
