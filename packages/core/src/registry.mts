// The runtime patch registry contract. In registry delivery the emitted tap
// carries no import at all — it looks its patch function up in a global the
// runtime shell populated before any module loaded (hook-overridden CJS
// sources cannot serve an injected require). The key format is shared with
// the Rust emission and must match it exactly.
import type { PatchEntry } from './config.mjs'

/** Global registry the runtime shell preloads patch functions into. */
export const PATCH_REGISTRY = Symbol.for('wrap-esm-lambda.patches')

/** The registry key for a patch entry — must match the Rust emission exactly. */
export function patchKey(entry: PatchEntry): string {
  return `${entry.patch.from}#${entry.patch.name}`
}

/**
 * A patch function as the registry holds it: the module's tapped bindings
 * arrive as get/set accessor properties. A patch may return anything (the
 * emitted tap ignores it), which is what lets the runtime shell wrap user
 * functions and signal a contained failure through the return value.
 */
export type PatchFunction = (accessors: Record<string, unknown>) => unknown

/** The registry as it lives on `globalThis`, keyed by `patchKey`. */
export type PatchRegistry = Record<string, PatchFunction>
