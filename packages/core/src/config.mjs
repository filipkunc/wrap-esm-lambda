// The declarative config surface — the part users touch. A config is a list
// of entries of two kinds:
// - wrap entries (`match` + `handler` + `wrapper`): AST-level rebind of an
//   exported const, the original Lambda-handler transform.
// - patch entries (`module` + `patch` + `bindings`): the generic exports tap —
//   Module._load-monkey-patching ergonomics, delivered by source transform.
//   The user's patch function receives the module's live bindings as get/set
//   accessors and does ordinary imperative patching against real objects.

/**
 * @typedef {Object} WrapperSpec
 * @property {string} name - identifier the wrapped export is called through, e.g. 'WrapAwsLambda'
 * @property {string} [from] - module specifier to import `name` from; omit if the
 *   identifier is provided some other way (e.g. a preloaded global)
 *
 * @typedef {Object} WrapEntry
 * @property {string | RegExp} match - matched against the module's absolute file path
 * @property {string} handler - the exported binding to wrap
 * @property {WrapperSpec} wrapper
 *
 * @typedef {Object} ModuleMatch
 * @property {string} name - package name, from the nearest package.json — or a
 *   Node builtin (`node:http`, `os`): builtin entries are patched eagerly at
 *   preload by the runtime shell (no source to transform; build-time shells
 *   cannot reach them)
 * @property {string} [versionRange] - semver range the package version must
 *   satisfy; for a builtin entry, checked against `process.versions.node`
 * @property {string[]} [files] - path suffixes within the package (e.g. 'dist-es/client.js');
 *   omit to match every file of the package; rejected for builtin entries
 *
 * @typedef {Object} PatchSpec
 * @property {string} name - exported patch function in `from`
 * @property {string} from - module specifier of the user's patch code
 *
 * @typedef {Object} PatchEntry
 * @property {ModuleMatch} module
 * @property {PatchSpec} patch
 * @property {string[]} bindings - exported names handed to the patch function
 *
 * @typedef {WrapEntry | PatchEntry} InstrumentEntry
 *
 * @typedef {Object} InstrumentConfig
 * @property {InstrumentEntry[]} entries
 */

/** Identity helper so config files get typing/autocomplete. @param {InstrumentConfig} config */
export function defineConfig(config) {
  return config
}

/** Sugar for a patches-only config. @param {PatchEntry[]} entries */
export function definePatches(entries) {
  return { entries }
}
