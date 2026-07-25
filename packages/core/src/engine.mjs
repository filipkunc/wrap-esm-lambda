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
//
// The default binding is also the one recovery path core takes on its own: a
// native addon that cannot be loaded (no prebuilt binary for the platform, a
// stripped container layer, npm's optional-dependency bug) degrades to the
// acorn engine with a warning rather than throwing out of `--import`. See
// engine-select.mjs — an explicitly requested engine is never substituted.
import { selectEngine } from './engine-select.mjs'
import { debug, warnOnce } from './diagnostics.mjs'

const ENGINES = {
  oxc: () => import('wrap-esm-lambda'),
  acorn: () => import('@wrap-esm-lambda/engine-acorn'),
}

const selected = await selectEngine(process.env.WRAP_ESM_LAMBDA_ENGINE, ENGINES, {
  onFallback: (err) => {
    const reason = err instanceof Error ? err.message : String(err)
    warnOnce(
      'engine',
      `the native oxc addon could not be loaded (${reason}) — falling back to the pure-JS acorn engine ` +
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
