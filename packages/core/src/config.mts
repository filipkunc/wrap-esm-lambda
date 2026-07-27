// The declarative config surface — the part users touch. A config is a list
// of patch entries (`module` + `patch` + `bindings`): the generic exports
// tap — Module._load-monkey-patching ergonomics, delivered by source
// transform. The user's patch function receives the module's live bindings
// as get/set accessors and does ordinary imperative patching against real
// objects.
//
// This used to carry a second entry kind — wrap entries, the original
// Lambda-handler transform (`match` + `handler` + `wrapper`) — until the
// tap's rewrite path could rebind every shape the wrap could, and the
// aws-lambda preset covered the runtime discovery. The standalone transform
// survives as the native addon's `transformLambda*` exports (the benchmark
// comparison subject); the config surface is tap-only.
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PackageModuleMatch {
  /**
   * package name, from the nearest package.json — or a Node builtin
   * (`node:http`, `os`): no source to transform, so the runtime shell patches
   * its exports object eagerly at preload, and the build shell aliases the
   * specifier to a generated wrapper module (see builtins.mts)
   */
  name: string
  /**
   * semver range the package version must satisfy; for a builtin entry,
   * checked against `process.versions.node`
   */
  versionRange?: string
  /**
   * path suffixes within the package (e.g. 'dist-es/client.js'); omit to match
   * every file of the package; rejected for builtin entries
   */
  files?: string[]
  path?: undefined
}

export interface PathModuleMatch {
  /**
   * file paths the module must match — an absolute path matches exactly, a
   * relative one as a suffix (the same rule `files` uses). For code that has
   * no useful package identity: an app's own files, a Lambda handler whose
   * location only the runtime environment knows (see the aws-lambda preset in
   * `@wrap-esm-lambda/hooks/aws-lambda`, which derives these from
   * `_HANDLER`/`LAMBDA_TASK_ROOT`). Backslashes are tolerated (Windows
   * configs); matching happens on forward-slash cleaned paths.
   */
  path: string | string[]
  name?: undefined
  versionRange?: undefined
  files?: undefined
}

export type ModuleMatch = PackageModuleMatch | PathModuleMatch

export interface PatchSpec {
  /** exported patch function in `from` */
  name: string
  /** module specifier of the user's patch code */
  from: string
}

export interface PatchEntry {
  module: ModuleMatch
  patch: PatchSpec
  /** exported names handed to the patch function */
  bindings: string[]
}

/** The one entry kind a config holds; the alias is the old union's name. */
export type InstrumentEntry = PatchEntry

export interface InstrumentConfig {
  entries: InstrumentEntry[]
}

/**
 * Resolve a `from` specifier to the absolute path both shells need: the
 * runtime shell imports it at preload, the build shell stringifies it into
 * an import appended to the *patched module* — where a relative or bare
 * specifier would resolve from the wrong place entirely (the target
 * package's own directory, which cannot see the config's dependencies under
 * pnpm's strict layout). Normalizing here, once, at config definition time,
 * makes the config a self-contained, installable unit:
 *
 * - an absolute path passes through untouched (the classic contract);
 * - a `file://` URL string (e.g. straight from `import.meta.resolve`) is
 *   converted to a path;
 * - `./` and `../` specifiers resolve against `base` — the config module's
 *   own `import.meta.url` — so a package can point at the patch files it
 *   ships next to the config;
 * - a bare package specifier resolves from `base` via Node's resolver, so a
 *   config may reference patch files another installed package exports.
 *
 * Relative and bare forms require `base`; resolution failures throw at
 * definition time — the loud path, not a broken import at first request.
 * Without `base` a non-absolute specifier passes through unchanged (the
 * legacy, documented-fragile behavior).
 */
function resolveFrom(from: string, base: string | undefined, what: string): string {
  if (from.startsWith('file://')) {
    return fileURLToPath(from)
  }
  if (isAbsolute(from)) {
    return from
  }
  if (base === undefined) {
    return from
  }
  if (from.startsWith('./') || from.startsWith('../')) {
    return fileURLToPath(new URL(from, base))
  }
  try {
    return createRequire(base).resolve(from)
  } catch (err) {
    throw new TypeError(`${what} '${from}' does not resolve from ${base}`, { cause: err })
  }
}

/** A patch entry with its `patch.from` resolved — the shape stays exact. */
function resolvePatchEntry(entry: PatchEntry, base: string | undefined): PatchEntry {
  return { ...entry, patch: { ...entry.patch, from: resolveFrom(entry.patch.from, base, 'patch.from') } }
}

/**
 * Identity helper so config files get typing/autocomplete. Pass
 * `import.meta.url` as `base` to write `patch.from` as specifiers relative
 * to the config file (or bare package specifiers) — they are resolved to
 * absolute paths here, at definition time.
 *
 * @param base the config module's `import.meta.url`
 */
export function defineConfig(config: InstrumentConfig, base?: string): InstrumentConfig {
  return { ...config, entries: config.entries.map((entry) => resolvePatchEntry(entry, base)) }
}

/**
 * Sugar for a patches-only config.
 *
 * @param base the config module's `import.meta.url`
 */
// The return type stays PatchEntry[] rather than widening to InstrumentEntry[]:
// a patches-only config IS patches only, and callers (the validator, tests,
// anything introspecting a config) should not have to re-narrow what this
// function already guarantees.
export function definePatches(entries: PatchEntry[], base?: string): { entries: PatchEntry[] } {
  return { entries: entries.map((entry) => resolvePatchEntry(entry, base)) }
}
