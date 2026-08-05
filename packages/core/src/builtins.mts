// Build-time reach into Node builtins. A builtin has no source for a
// bundler to transform, and injecting an eager patch at the entry loses the
// race against ESM facade snapshots (`import { hostname } from "node:os"`
// captures the binding when the facade evaluates, before any entry body
// code runs). The build shell therefore takes the one spot it fully owns:
// module resolution. Every configured builtin specifier is aliased to a
// generated **wrapper module** that grabs the real exports object via
// `process.getBuiltinModule` (a global — no builtin import, so nothing to
// race), applies the patches against it, then re-exports the patched
// bindings. Consumer shapes all land:
//
// - named imports bind to the wrapper's own exports, snapshotted AFTER the
//   patches ran;
// - default imports and namespace access get the real (mutated) exports
//   object;
// - a runtime `require()` — createRequire escapes the bundle's aliasing —
//   still observes mutations and rebinds, because the wrapper patched the
//   real object, not a copy.
//
// The wrapper's export list is enumerated from the building Node's own
// builtin (the bundle freezes it, like everything else a bundle freezes);
// `process.getBuiltinModule` needs Node >= 22.3 where the bundle runs.
import { createRequire, isBuiltin } from 'node:module'
import { builtinPatchEntries } from './match.mjs'
import { patchKey } from './registry.mjs'
import type { InstrumentConfig, PatchEntry } from './config.mjs'

const requireBuiltin = createRequire(import.meta.url)

/**
 * The hybrid double-patch guard for one builtin entry, shared by both
 * shells: the runtime shell's eager preload and a build-time wrapper both
 * mark `globalThis[Symbol.for(key)]` before applying, so combining the
 * modes never wraps a builtin's method twice.
 */
export function builtinGuardKey(entry: PatchEntry): string {
  return `wrap-esm-lambda.builtin:${entry.module.name}#${patchKey(entry)}`
}

/**
 * Both spellings a consumer can import a configured builtin under —
 * `node:os` and `os` name the same module (scheme-only builtins like
 * `node:test` have just the one).
 */
function builtinSpellings(name: string): string[] {
  const other = name.startsWith('node:') ? name.slice('node:'.length) : `node:${name}`
  return isBuiltin(other) ? [name, other] : [name]
}

/**
 * specifier -> canonical configured name, for every builtin the config
 * patches — the alias table the build shell's resolveId consults. Empty when
 * the config has no builtin entries, so the common case costs one lookup.
 * @param {import('./config.mjs').InstrumentConfig} config
 * @returns {Map<string, string>}
 */
export function builtinAliases(config: InstrumentConfig): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const entry of builtinPatchEntries(config)) {
    for (const spelling of builtinSpellings(entry.module.name)) {
      aliases.set(spelling, entry.module.name)
    }
  }
  return aliases
}

/** `export { local as name }` braces: bare identifiers stay bare. */
function braceName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

/**
 * A requested binding the builtin does not have is the version-drift alarm,
 * thrown with the same message wherever the check runs — at bundle time in
 * `builtinWrapperSource`, at runtime in the shell's `applyBuiltinPatches`
 * (via `builtinAccessors` below). One producer, so the two spots that are
 * contracted to behave identically cannot drift apart.
 */
function assertBuiltinBinding(target: Record<string, unknown>, binding: string, moduleName: string): void {
  if (!(binding in target)) {
    const available = Object.keys(target).slice(0, 20).join(', ')
    throw new TypeError(`binding '${binding}' not found in ${moduleName} (available: ${available}, ...)`)
  }
}

/**
 * The live get/set accessor object a builtin patch function is handed at
 * runtime: one enumerable accessor pair per requested binding, reading and
 * writing through the REAL exports object (so a runtime `require()` observes
 * rebinds too). Validates every binding first — the same check, with the
 * same error, that `builtinWrapperSource` runs at bundle time; the generated
 * wrapper's emitted accessors mirror exactly what this builds live.
 */
export function builtinAccessors(
  target: Record<string, unknown>,
  moduleName: string,
  bindings: string[],
): Record<string, unknown> {
  const accessors: Record<string, unknown> = {}
  for (const name of bindings) {
    assertBuiltinBinding(target, name, moduleName)
    Object.defineProperty(accessors, name, {
      enumerable: true,
      get: () => target[name],
      set: (value) => {
        target[name] = value
      },
    })
  }
  return accessors
}

/**
 * The generated wrapper module source for one builtin, covering every
 * config entry that targets it. Mirrors the runtime shell's
 * `applyBuiltinPatches` contract exactly: only the requested bindings are
 * handed over, as get/set accessors on the real exports object, and a
 * requested binding the builtin does not have is a hard error — thrown here
 * at bundle time, where the building Node can be asked.
 *
 * @param name the configured builtin name ('node:os', 'os', ...)
 * @param entries entries targeting it
 */
export function builtinWrapperSource(name: string, entries: PatchEntry[]): string {
  const target = requireBuiltin(name) as Record<string, unknown>
  let source = `// generated by @wrap-esm-lambda/unplugin for ${name}\n`
  source += `const __wel_target = process.getBuiltinModule(${JSON.stringify(name)});\n`
  entries.forEach((entry, i) => {
    source += `import { ${entry.patch.name} as __wel_bp_${i} } from ${JSON.stringify(entry.patch.from)};\n`
  })
  entries.forEach((entry, i) => {
    for (const binding of entry.bindings) {
      assertBuiltinBinding(target, binding, name)
    }
    const props = entry.bindings
      .map(
        (binding) =>
          `\n  get ${braceName(binding)}() { return __wel_target[${JSON.stringify(binding)}]; },` +
          `\n  set ${braceName(binding)}(v) { __wel_target[${JSON.stringify(binding)}] = v; },`,
      )
      .join('')
    const guard = JSON.stringify(builtinGuardKey(entry))
    source += `;(() => {\nconst __wel_done = Symbol.for(${guard});\n`
    source += `if (globalThis[__wel_done]) return;\nglobalThis[__wel_done] = true;\n`
    source += `__wel_bp_${i}({${props}\n});\n})();\n`
  })
  source += `export default __wel_target;\n`
  const names = Object.keys(target).filter((key) => key !== 'default')
  names.forEach((key, i) => {
    source += `const __wel_e${i} = __wel_target[${JSON.stringify(key)}];\n`
    source += `export { __wel_e${i} as ${braceName(key)} };\n`
  })
  return source
}
