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
// - apply.mjs    — entries -> instrumented source, via the native oxc addon,
//                  plus the double-wrap sentinel
// - registry.mjs — the runtime patch-function registry contract

/**
 * @typedef {import('./config.mjs').WrapperSpec} WrapperSpec
 * @typedef {import('./config.mjs').WrapEntry} WrapEntry
 * @typedef {import('./config.mjs').ModuleMatch} ModuleMatch
 * @typedef {import('./config.mjs').PatchSpec} PatchSpec
 * @typedef {import('./config.mjs').PatchEntry} PatchEntry
 * @typedef {import('./config.mjs').InstrumentEntry} InstrumentEntry
 * @typedef {import('./config.mjs').InstrumentConfig} InstrumentConfig
 */

export { defineConfig, definePatches } from './config.mjs'
export { nearestPackage, matchEntries, createMatcher, builtinPatchEntries } from './match.mjs'
export { runtimeFormatFor, moduleKindFor } from './format.mjs'
export { SENTINEL, SENTINEL_TEXT, transformMatched, applyMatched, inlineMap } from './apply.mjs'
export { PATCH_REGISTRY, patchKey } from './registry.mjs'
