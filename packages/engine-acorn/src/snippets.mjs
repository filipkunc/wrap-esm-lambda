// Emitted-text builders shared by the tap's CJS and ESM paths. The output is
// byte-identical to the native oxc engine's emission (src/transform.rs on the
// Rust side): both engines feed the same shells and the same runtime registry
// contract, and the engine-parity tests diff the two emissions directly.

/** Minimal JS string literal escaping for generated specifiers. */
export function quoteJsString(value) {
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
export function isPlainPropertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

/**
 * A name in `import { <name> as x }` / `export { x as <name> }` braces:
 * plain identifiers stay bare, anything else becomes a string literal
 * (`import { "a-b" as x }` is legal ESM).
 */
export function braceName(name) {
  return isPlainPropertyName(name) ? name : quoteJsString(name)
}

/**
 * The get/set accessor properties for the tapped bindings. `local` is how the
 * module reaches the value (a local identifier for ESM, a `module.exports.X`
 * path for CJS). `verifySet` guards the one silent failure mode assignment
 * has: bundled sloppy-mode CJS with getter-only exports no-ops the write, so
 * the setter re-reads the property and throws if the rebind did not take.
 *
 * @param {Accessor[]} accessors
 * @typedef {{ exported: string, local: string, reassignable: boolean, verifySet: boolean }} Accessor
 */
function accessorProperties(accessors) {
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
 * aliased by `aliasIndex` for the bundler to resolve.
 *
 * @param {Accessor[]} accessors
 */
export function buildSnippet(accessors, patchName, patchFrom, registry, aliasIndex) {
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
  return `\nimport { ${patchName} as ${alias} } from ${quoteJsString(patchFrom)};\n${alias}({${props}\n});\n`
}

/**
 * Append-only redirect for a star-forwarded name, exploiting that an explicit
 * named export shadows a bare `export *` for the same name: the star
 * statement stays untouched, and these three appended statements (imports and
 * exports hoist) reroute `name` through a rebindable local.
 */
export function starStub(name, source, local) {
  const braced = braceName(name)
  return `\nimport { ${braced} as ${local}_src } from ${quoteJsString(source)};\nlet ${local} = ${local}_src;\nexport { ${local} as ${braced} };\n`
}
