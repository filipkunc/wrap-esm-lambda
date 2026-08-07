// The privates bridge — the class-body injection behind the declarative
// `privates` config field (docs/design-private-bindings.md), implemented
// twice: here on acorn + magic-string, and natively in src/transform/
// privates.rs. `#field` is brand-scoped to the class body's lexical scope,
// so runtime patches can never reach it; this engine owns the source before
// evaluation, where the class body is just text. Seeing `privates`, the tap
// injects a static block into the named class's body — the one place the
// brand is legal — publishing get/set closures under a well-known symbol:
//
//   static {
//     Object.defineProperty(this, Symbol.for("wrap-esm-lambda.privates"), { value: { ... } });
//   }
//
// The member text is printed by hand in oxc codegen's structural formatting
// (`memberText` below): the native engine grafts the member into the AST
// and regenerates the module, so on codegen-conventional sources the two
// engines' rewrites stay byte-identical — pinned by engine-parity.spec.ts.
//
// The patch reaches the bridge from the class binding it already receives
// (`bindings.Db[Symbol.for("wrap-esm-lambda.privates")]`) — and a subclass
// wrapper inherits it through the static side of the prototype chain, so
// the usual wrap-by-extends pattern keeps working unchanged.
//
// Two deliberate departures from the design sketch, shared by both engines:
// - a static block + defineProperty rather than `static [SYMBOL] = ...`:
//   the field form would be an enumerable own property, and the bridge must
//   not leak through reflection that merely copies enumerable keys (object
//   spread and Object.assign both copy enumerable symbol properties);
//   defineProperty's defaults make it non-enumerable, non-writable and
//   non-configurable in one move.
// - descriptor-shaped entries (`{ get, set }`) rather than positional
//   `[get, set]` pairs: a slot exists only when the language permits the
//   operation — a private method or get-only accessor grants no `set`
//   (writing would throw by spec), a set-only accessor grants no `get` —
//   so the bridge's own shape is the honest capability report.
//
// Prototype scope: top-level class declarations (exported or not, including
// a NAMED `export default class`) and class expressions initializing a
// top-level `const`/`let`/`var`. Anonymous default classes and nested/inner
// classes have no name to key on and are not searched.
import type { AnyNode, ClassDeclaration, ClassExpression, Program } from 'acorn'
import { quoteJsString } from './snippets.mjs'

/**
 * The well-known registry key: patches read the bridge off the class binding
 * via `Symbol.for(PRIVATE_BRIDGE_KEY)`.
 */
export const PRIVATE_BRIDGE_KEY = 'wrap-esm-lambda.privates'

type ClassNode = ClassDeclaration | ClassExpression

/** What the class body statically grants for one private name. */
interface Slot {
  name: string
  readable: boolean
  writable: boolean
}

/** One planned injection: the bridge member and where it goes. */
export interface BridgePlan {
  /** Insertion offset — immediately before the class body's closing brace. */
  insertAt: number
  /**
   * The `static { ... }` member text, fully indented for a top-level class
   * body (tab indentation — the formatting oxc codegen regenerates on the
   * native side, which the parity suite diffs byte-for-byte).
   */
  member: string
}

/** Every named class the prototype can target, in source order. */
function collectClasses(program: Program): Map<string, ClassNode> {
  const classes = new Map<string, ClassNode>()
  const add = (name: string, node: ClassNode): void => {
    if (!classes.has(name)) classes.set(name, node)
  }
  const fromStatement = (stmt: AnyNode | null | undefined): void => {
    if (stmt == null) return
    // acorn types `export default class {}` as an anonymous variant with
    // `id: null` — no name to key `privates` on, out of prototype scope
    if (stmt.type === 'ClassDeclaration' && stmt.id !== null) {
      add(stmt.id.name, stmt as ClassDeclaration)
    } else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'Identifier' && decl.init != null && decl.init.type === 'ClassExpression') {
          add(decl.id.name, decl.init)
        }
      }
    }
  }
  for (const stmt of program.body) {
    if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
      fromStatement(stmt.declaration)
    } else {
      fromStatement(stmt)
    }
  }
  return classes
}

/**
 * The private names a class body declares, each with what the language
 * permits on it: fields read and write; methods and getters read; setters
 * write. Accessor pairs merge (`get #x` + `set #x` grants both). Static
 * privates are included as-is — the closures take the receiver as an
 * argument, and for a static private that receiver is the class itself.
 */
function scanSlots(cls: ClassNode): Map<string, Slot> {
  const slots = new Map<string, Slot>()
  const grant = (bare: string, readable: boolean, writable: boolean): void => {
    const name = `#${bare}`
    const slot = slots.get(name) ?? { name, readable: false, writable: false }
    slot.readable ||= readable
    slot.writable ||= writable
    slots.set(name, slot)
  }
  for (const element of cls.body.body) {
    if (element.type === 'PropertyDefinition' && element.key.type === 'PrivateIdentifier') {
      grant(element.key.name, true, true)
    } else if (element.type === 'MethodDefinition' && element.key.type === 'PrivateIdentifier') {
      if (element.kind === 'set') grant(element.key.name, false, true)
      else grant(element.key.name, true, false)
    }
  }
  return slots
}

const tabs = (n: number): string => '\t'.repeat(n)

/**
 * `(o, v) => { o.#x = v; }` printed the way oxc codegen prints a block-body
 * arrow: the block breaks, indented one past the line the arrow starts on.
 */
function setArrow(name: string, depth: number): string {
  return `(o, v) => {\n${tabs(depth + 1)}o.${name} = v;\n${tabs(depth)}}`
}

/**
 * One slot object, in oxc codegen's structural formatting (the native
 * engine grafts the member into the AST and regenerates; this engine must
 * print the identical text by hand — engine-parity diffs the two): an
 * object with one property stays inline, one with two breaks each property
 * onto its own line. `depth` is the indentation of the line the slot
 * starts on.
 */
function slotText(slot: Slot, depth: number): string {
  const get = `get: (o) => o.${slot.name}`
  if (slot.readable && slot.writable) {
    return `{\n${tabs(depth + 1)}${get},\n${tabs(depth + 1)}set: ${setArrow(slot.name, depth + 1)}\n${tabs(depth)}}`
  }
  if (slot.readable) return `{ ${get} }`
  return `{ set: ${setArrow(slot.name, depth)} }`
}

/** The full `static { ... }` member, indented for a top-level class body. */
function memberText(slots: Slot[]): string {
  const entry = (slot: Slot, depth: number): string => `${quoteJsString(slot.name)}: ${slotText(slot, depth)}`
  const inner =
    slots.length === 1
      ? `{ ${entry(slots[0]!, 2)} }`
      : `{\n${slots.map((slot) => `${tabs(3)}${entry(slot, 3)}`).join(',\n')}\n${tabs(2)}}`
  return (
    `\tstatic {\n\t\tObject.defineProperty(this, Symbol.for(${quoteJsString(PRIVATE_BRIDGE_KEY)}), ` +
    `{ value: ${inner} });\n\t}`
  )
}

/**
 * Validate every requested private against the class bodies and plan the
 * injections. All refusals throw here, BEFORE any source edit, and are
 * phrased for `validateConfig` to surface ahead of load time — a missing
 * private must be a validation-time report, not a runtime `undefined`.
 * Deliberately NOT worded "not found in module": that phrase is the tap
 * contract's missing-EXPORT alarm (`isMissingExportError` in core keys the
 * star-graph retry on it), and a privates refusal must never trigger it.
 */
export function planPrivateBridges(program: Program, privates: Map<string, string[]>): BridgePlan[] {
  if (privates.size === 0) return []
  const classes = collectClasses(program)
  const plans: BridgePlan[] = []
  for (const [className, names] of privates) {
    if (names.length === 0) continue
    const cls = classes.get(className)
    if (cls === undefined) {
      const known = [...classes.keys()]
      const hint = known.length === 0 ? 'no named top-level classes' : `top-level classes: ${known.join(', ')}`
      throw new Error(`privates: no top-level class named '${className}' (${hint})`)
    }
    const slots = scanSlots(cls)
    const requested = names.map((name) => {
      const slot = slots.get(name)
      if (slot === undefined) {
        const available = [...slots.keys()].join(', ')
        throw new Error(
          `privates: '${name}' not found in class '${className}' (available: ${available.length === 0 ? 'none' : available})`,
        )
      }
      return slot
    })
    plans.push({ insertAt: cls.body.end - 1, member: memberText(requested) })
  }
  return plans
}
