// Emitted-text builders shared by the tap's CJS and ESM paths. The output is
// byte-identical to the native oxc engine's emission (src/transform.rs on the
// Rust side): both engines feed the same shells and the same runtime registry
// contract, and the engine-parity tests diff the two emissions directly.

/** Minimal JS string literal escaping for generated specifiers. */
export function quoteJsString(value: string): string {
  let out = '"'
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"'
        break
      case '\\':
        out += '\\\\'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      default:
        out += ch
    }
  }
  return out + '"'
}

/** True when `name` can appear bare as an object-literal property name. */
function isPlainPropertyName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

/**
 * A name in `import { <name> as x }` / `export { x as <name> }` braces:
 * plain identifiers stay bare, anything else becomes a string literal
 * (`import { "a-b" as x }` is legal ESM).
 */
export function braceName(name: string): string {
  return isPlainPropertyName(name) ? name : quoteJsString(name)
}

/**
 * One tapped binding as the emitted snippet sees it: `local` is how the module
 * reaches the value, and the two flags record what the resolver worked out
 * about writing to it.
 */
export interface Accessor {
  exported: string
  local: string
  reassignable: boolean
  verifySet: boolean
}

/**
 * The get/set accessor properties for the tapped bindings. `local` is how the
 * module reaches the value (a local identifier for ESM, a `module.exports.X`
 * path for CJS). `verifySet` guards the one silent failure mode assignment
 * has: bundled sloppy-mode CJS with getter-only exports no-ops the write, so
 * the setter re-reads the property and throws if the rebind did not take.
 *
 */
function accessorProperties(accessors: Accessor[]): string {
  let out = ''
  for (const { exported, local, reassignable, verifySet } of accessors) {
    const name = isPlainPropertyName(exported) ? exported : quoteJsString(exported)
    out += `\n  get ${name}() { return ${local}; },`
    if (reassignable) {
      const verify = verifySet
        ? ` if (${local} !== v) throw new TypeError("wrap-esm-lambda: rebinding ${exported} had no effect (getter-only CJS export)");`
        : ''
      out += `\n  set ${name}(v) { ${local} = v;${verify} },`
    }
  }
  return out
}

/**
 * Per-entry accessor snippet (the patch call). Registry delivery looks the
 * patch up in the `Symbol.for("wrap-esm-lambda.patches")` global the runtime
 * shell preloads; import delivery emits a static import of `patchFrom`
 * aliased by `aliasIndex` for the bundler to resolve — except into a CJS
 * module, which gets a `require()` in an IIFE instead: an `import` statement
 * appended to CJS source would flip the module's format under every
 * bundler's syntax detection and break its `module.exports`.
 *
 */
export function buildSnippet(
  accessors: Accessor[],
  patchName: string,
  patchFrom: string,
  registry: boolean,
  aliasIndex: number,
  cjs: boolean,
): string {
  const props = accessorProperties(accessors)
  if (registry) {
    const key = quoteJsString(`${patchFrom}#${patchName}`)
    return (
      '\n;(() => {\nconst __wel_registry = globalThis[Symbol.for("wrap-esm-lambda.patches")];\n' +
      `const __wel_patch = __wel_registry && __wel_registry[${key}];\n` +
      `if (__wel_patch) __wel_patch({${props}\n});\n})();\n`
    )
  }
  const alias = `__wel_patch_${aliasIndex}`
  const call = guardedCall(alias, `${patchFrom}#${patchName}`, props)
  if (cjs) {
    return `\n;(() => {\nconst { ${patchName}: ${alias} } = require(${quoteJsString(patchFrom)});\n${call}})();\n`
  }
  return `\nimport { ${patchName} as ${alias} } from ${quoteJsString(patchFrom)};\n${call}`
}

/**
 * The patch call itself, in import delivery: wrapped so a throwing patch
 * cannot break the evaluation of the module it patches. The runtime shell
 * contains that failure in the function it registers (@wrap-esm-lambda/hooks,
 * guardPatch), but a bundled artifact has no registry to wrap — the emitted
 * code calls the user's function directly, so the containment is emitted too.
 *
 * Deliberate properties: WRAP_ESM_LAMBDA_STRICT is read with the same
 * semantics as the runtime shell (unset, empty, `0` and `false` are off), a
 * `process`-less bundle does not throw a second error out of the catch, and
 * the report matches the runtime's message shape so one grep finds both. The
 * `__wel_err` / `__wel_s` bindings are block-scoped to the catch, so several
 * entries in one module cannot collide.
 *
 * Byte-identical to the native engine's `push_guarded_call` (src/transform.rs).
 */
function guardedCall(alias: string, key: string, props: string): string {
  return (
    `try {\n${alias}({${props}\n});\n} catch (__wel_err) {\n` +
    'const __wel_s = typeof process === "undefined" ? "" : process.env.WRAP_ESM_LAMBDA_STRICT;\n' +
    'if (__wel_s && __wel_s !== "0" && __wel_s !== "false") throw __wel_err;\n' +
    `console.error(${quoteJsString(`wrap-esm-lambda: patch '${key}' failed, continuing without it:`)}, __wel_err);\n}\n`
  )
}

/**
 * Append-only redirect for a star-forwarded name, exploiting that an explicit
 * named export shadows a bare `export *` for the same name: the star
 * statement stays untouched, and these three appended statements (imports and
 * exports hoist) reroute `name` through a rebindable local.
 */
export function starStub(name: string, source: string, local: string): string {
  const braced = braceName(name)
  return `\nimport { ${braced} as ${local}_src } from ${quoteJsString(source)};\nlet ${local} = ${local}_src;\nexport { ${local} as ${braced} };\n`
}
