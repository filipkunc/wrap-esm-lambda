// The runtime patch registry contract. In registry delivery the emitted tap
// carries no import at all — it looks its patch function up in a global the
// runtime shell populated before any module loaded (hook-overridden CJS
// sources cannot serve an injected require). The key format is shared with
// the Rust emission and must match it exactly.

/** Global registry the runtime shell preloads patch functions into. */
export const PATCH_REGISTRY = Symbol.for('wrap-esm-lambda.patches')

/** The registry key for a patch entry — must match the Rust emission exactly. */
export function patchKey(entry) {
  return `${entry.patch.from}#${entry.patch.name}`
}
