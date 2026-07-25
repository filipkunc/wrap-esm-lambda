// The declarative config surface — the part users touch. A config is a list
// of entries of two kinds:
// - wrap entries (`match` + `handler` + `wrapper`): AST-level rebind of an
//   exported const, the original Lambda-handler transform.
// - patch entries (`module` + `patch` + `bindings`): the generic exports tap —
//   Module._load-monkey-patching ergonomics, delivered by source transform.
//   The user's patch function receives the module's live bindings as get/set
//   accessors and does ordinary imperative patching against real objects.
//
// The two entry shapes carry `never`-typed markers for each other's
// discriminating fields (`patch?: undefined` on a wrap entry), so the
// `entry.patch ? ... : ...` narrowing the shells already did in JavaScript is
// what the type checker now follows too.
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WrapperSpec {
  /** identifier the wrapped export is called through, e.g. 'WrapAwsLambda' */
  name: string
  /**
   * module specifier to import `name` from; omit if the identifier is provided
   * some other way (e.g. a preloaded global)
   */
  from?: string
}

export interface WrapEntry {
  /** matched against the module's absolute file path */
  match: string | RegExp
  /** the exported binding to wrap */
  handler: string
  wrapper: WrapperSpec
  patch?: undefined
  module?: undefined
}

export interface ModuleMatch {
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
}

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
  match?: undefined
  wrapper?: undefined
}

export type InstrumentEntry = WrapEntry | PatchEntry

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

function resolveEntry(entry: InstrumentEntry, base: string | undefined): InstrumentEntry {
  if (entry.patch) {
    return { ...entry, patch: { ...entry.patch, from: resolveFrom(entry.patch.from, base, 'patch.from') } }
  }
  if (entry.wrapper?.from !== undefined) {
    return { ...entry, wrapper: { ...entry.wrapper, from: resolveFrom(entry.wrapper.from, base, 'wrapper.from') } }
  }
  return entry
}

/**
 * Identity helper so config files get typing/autocomplete. Pass
 * `import.meta.url` as `base` to write `patch.from` / `wrapper.from` as
 * specifiers relative to the config file (or bare package specifiers) —
 * they are resolved to absolute paths here, at definition time.
 *
 * @param base the config module's `import.meta.url`
 */
export function defineConfig(config: InstrumentConfig, base?: string): InstrumentConfig {
  return { ...config, entries: config.entries.map((entry) => resolveEntry(entry, base)) }
}

/**
 * Sugar for a patches-only config.
 *
 * @param base the config module's `import.meta.url`
 */
export function definePatches(entries: PatchEntry[], base?: string): InstrumentConfig {
  return { entries: entries.map((entry) => resolveEntry(entry, base)) }
}
