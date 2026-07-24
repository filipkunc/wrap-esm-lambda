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

const ENGINES = {
  oxc: () => import('wrap-esm-lambda'),
  acorn: () => import('@wrap-esm-lambda/engine-acorn'),
}

/** The engine this process is bound to: 'oxc' (native, default) or 'acorn' (pure JS). */
export const engineName = process.env.WRAP_ESM_LAMBDA_ENGINE || 'oxc'

if (!Object.hasOwn(ENGINES, engineName)) {
  throw new Error(
    `wrap-esm-lambda: unknown engine '${engineName}' in WRAP_ESM_LAMBDA_ENGINE (expected ${Object.keys(ENGINES).join(' or ')})`,
  )
}

export const { esmModuleExports, exportsTap, exportsTapFromBuffer, transformLambdaWithMapObject } =
  await ENGINES[engineName]()
