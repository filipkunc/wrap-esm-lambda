// Shared core of the hybrid instrumentation setup: one declarative config,
// consumed by both the runtime shell (@wrap-esm-lambda/hooks, a
// `registerHooks` load hook) and the build-time shell
// (@wrap-esm-lambda/unplugin, a bundler plugin). Both shells call
// `applyMatched`, so the instrumented code is byte-identical no matter which
// mode produced it.
//
// The module layout follows the pipeline a practical patch travels:
// - config.mjs   — the entry shapes users write (defineConfig/definePatches)
// - match.mjs    — which entries apply to which module (package identity,
//                  semver range, file suffixes; builtins split out)
// - format.mjs   — the CJS-or-ESM decision the emitted tap depends on
// - engine.mjs   — the transform engine binding: native oxc addon (default)
//                  or the pure-JS acorn engine (WRAP_ESM_LAMBDA_ENGINE)
// - apply.mjs    — entries -> instrumented source, via the engine, plus the
//                  double-wrap sentinel
// - registry.mjs — the runtime patch-function registry contract
// - diagnostics.mjs — the failure policy the shells apply (kill switch,
//                  strict mode, debug tracing, recovered-failure log)

export type {
  ModuleMatch,
  PackageModuleMatch,
  PathModuleMatch,
  PatchSpec,
  PatchEntry,
  InstrumentEntry,
  InstrumentConfig,
} from './config.mjs'
export type { Applied, ApplyOptions, Delivery, Source } from './apply.mjs'
export type { BuiltinPatchEntry, PackageInfo } from './match.mjs'
export type { PatchFunction, PatchRegistry } from './registry.mjs'
export type { RecoveredFailure } from './diagnostics.mjs'
export type { SelectEngineOptions } from './engine-select.mjs'
export type { EsmExportsInfo, TapEntryInput, TapResult, TapStarResolution, TransformEngine } from './engine.mjs'

export { defineConfig, definePatches } from './config.mjs'
export { engineName } from './engine.mjs'
export { nearestPackage, matchEntries, createMatcher, builtinPatchEntries } from './match.mjs'
export { runtimeFormatFor, moduleKindFor } from './format.mjs'
export { SENTINEL, SENTINEL_TEXT, applyMatched, inlineMap } from './apply.mjs'
export { PATCH_REGISTRY, patchKey } from './registry.mjs'
export { builtinAliases, builtinWrapperSource, builtinGuardKey, builtinAccessors } from './builtins.mjs'
export { DEBUG, debug, isDisabled, isStrict, recover, warnOnce, instrumentationFailures } from './diagnostics.mjs'
export { selectEngine, FALLBACK_ENGINE } from './engine-select.mjs'
export { TAP_CONTRACT_VERSION, isMissingExportError } from './engine.mjs'
export { resolveConfigUrl } from './locate.mjs'
export { validateConfig, formatReport } from './validate.mjs'
export type { CheckStatus, EntryReport, ValidationReport } from './validate.mjs'
