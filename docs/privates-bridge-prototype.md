# Privates bridge: acorn-engine prototype findings

Status: prototype landed (acorn engine only). This is the follow-up to
[design-private-bindings.md](./design-private-bindings.md), which suggested
prototyping the class-body injection in the acorn engine first "to learn how
invasive the class-body surgery is" before porting to the Rust engine and
bumping the tap contract. This note records what the prototype decided and
what the port must replicate.

## What landed

- `packages/engine-acorn/src/privates.mts` — class lookup, private-name
  scan, validation, and the bridge member emission.
- `TapEntryInput.privates?: Record<string, string[]>` (acorn engine only;
  core's `TapEntryInput` is untouched — nothing reaches this field through
  config yet).
- `__test__/privates-bridge.spec.ts` — end-to-end: transformed modules
  actually evaluate, and the bridge operates on genuine branded instances,
  including through the subclass-wrapper patch pattern the design validated.

Answer to the design's driving question: the surgery is **not invasive**.
One insertion point per class (immediately before the class body's closing
brace), append-only relative to the class body, no interaction with the
existing export rewrites — `applyBridges` and `applyRewrites` compose on the
same MagicString without coordination. The map stays honest for free.

## Decisions the prototype made (and the port inherits)

Two deliberate departures from the design sketch:

1. **A static block, not a static field.** The sketch's
   `static [PRIVATE_BRIDGE] = {...}` would be an enumerable own property;
   object spread and `Object.assign` copy enumerable symbol keys, so a
   wrapper built by cloning statics would silently carry the bridge. The
   emitted member is instead

   ```js
   static { Object.defineProperty(this, Symbol.for("wrap-esm-lambda.privates"), { value: { ... } }); }
   ```

   — non-enumerable, non-writable, non-configurable by defineProperty's
   defaults. Static blocks share the ES2022 baseline with private fields:
   any parser that accepts `#x` accepts `static {}`.

2. **Descriptor-shaped entries, not positional pairs.** A slot exists only
   when the language permits the operation, so the bridge's shape is the
   capability report:
   - field → `{ get, set }`
   - private method or get-only accessor → `{ get }` (writing throws by
     spec, so no setter is offered)
   - set-only accessor → `{ set }`
   - accessor pairs merge; static privates are included as-is (the
     receiver argument is the class itself).

Other contract-relevant behavior pinned by the spec:

- The bridge is reachable from the class binding the patch already receives
  (`bindings.Db[Symbol.for('wrap-esm-lambda.privates')]`), and a subclass
  wrapper inherits it through the static side of the prototype chain — no
  new patch-argument surface was needed for the prototype. Whether the
  final surface stays this way is still open (the design left it TBD).
- Any planned bridge forces the rewrite path (`code` non-null), even when
  every tapped binding would have taken the append-only fast path.
- Several entries bridging the same class converge on ONE injected static
  block (union of names, first-seen order) — same convergence rule as
  overlapping binding rewrites.
- Refusals throw before any source edit, phrased for `validateConfig` to
  surface ahead of load time — and deliberately NOT worded "not found in
  module", because that exact phrase is the missing-export alarm
  `isMissingExportError` keys the star-graph retry on:
  - `privates: no top-level class named 'X' (top-level classes: ...)`
  - `privates: '#x' not found in class 'X' (available: ...)`
  - `privates: only ESM modules are supported (requested for a CJS module)`

## Prototype scope (the design's "edge cases to decide up front")

Decided by this prototype:

- **Class shapes reached:** top-level class declarations (exported or not,
  including a _named_ `export default class`) and class expressions
  initializing a top-level `const`/`let`/`var`. Anonymous default classes
  and nested/inner classes have no name to key `privates` on — out of
  scope.
- **Static privates:** bridged as-is; the receiver is the class.
- **Private methods:** readable (the getter returns the callable); never
  writable.
- **Enumerability:** non-enumerable, symbol-keyed (see decision 1).

Still open for the implementation phase:

- Same-name shadowing across multiple classes in one module (first-seen
  wins today; the validator should probably refuse instead).
- The final patch-facing surface (symbol lookup off the binding vs. an
  explicit capability argument) and whether hooks/core should export the
  symbol key (`PRIVATE_BRIDGE_KEY` is exported from the acorn engine for
  now).
- Core plumbing: the `privates` config field, `validateConfig` reporting
  (including the version-range warning the design calls for), and the
  corpus survey that decides whether this earns its contract-version bump.

## What the Rust port must replicate

- The emitted member, byte-identical (engine-parity will diff it): the
  single-line static block above, entries in request order, each
  `"#name": { get: (o) => o.#name, set: (o, v) => { o.#name = v; } }` with
  sides dropped per the capability rules.
- Insertion inside the class body as the last element. Note oxc's rewrite
  path regenerates the whole program through codegen, so "insertion point"
  there means an AST child, not a text offset — the parity suite's job is
  to pin that the two paths converge on conventionally formatted sources.
- The refusal messages, verbatim, including the constraint that none of
  them match `/not found in module/`.
- `TAP_CONTRACT_VERSION` 2 → 3 lands only when both engines emit the
  bridge (the version is asserted in three places at once; see
  engine-parity.spec.ts).
