# Privates bridge: engine implementation notes

Status: implemented in BOTH engines — the acorn prototype first (which this
note originally handed off), then the native oxc port. This is the follow-up
to [design-private-bindings.md](./design-private-bindings.md), which
suggested prototyping the class-body injection in the acorn engine "to learn
how invasive the class-body surgery is" before porting to the Rust engine
and bumping the tap contract. The remaining step from that sequencing is the
core plumbing (config field, `validateConfig`, the corpus demand survey) and
with it the `TAP_CONTRACT_VERSION` bump — the engines are ready and pinned
against each other; core does not send `privates` yet.

## What landed

- `packages/engine-acorn/src/privates.mts` — class lookup, private-name
  scan, validation, and the hand-printed bridge member (acorn engine).
- `src/transform/privates.rs` — the native twin: same lookup/scan/validation
  (messages shared verbatim), member injected by parsing a synthetic class
  and grafting the static block into the target class body, then printed by
  oxc codegen with the rest of the rewritten module.
- `TapEntryInput.privates?: Record<string, string[]>` on both engines' tap
  surfaces. On the native side the field crosses napi as an `IndexMap`
  (napi's `object_indexmap` feature) so the emission follows the JS
  object's insertion order — determinism is part of the emission contract.
- `__test__/privates-bridge.spec.ts` — end-to-end per engine: transformed
  modules actually evaluate, and the bridge operates on genuine branded
  instances, including through the subclass-wrapper patch pattern the
  design validated.
- `__test__/engine-parity.spec.ts` — byte-identical whole-module rewrites
  across engines for the bridge (field pairs, single slots, lone accessors,
  static privates, composition with a `const` demotion), and identical
  refusal messages.
- `benchmark/tap-cases.ts` — the bridge priced on a real class-heavy
  module: hono's `Context` (11 KB, ~20 private fields). Representative
  numbers (release build, one machine): oxc fast-path tap ~56 µs vs bridge
  rewrite ~111 µs (the whole-module codegen regeneration is the cost);
  acorn ~348 µs vs ~370 µs (magic-string splices in place, so the parse
  dominates and the bridge is nearly free). Both sit far under
  orchestrion's ~1 ms body rewrite on a file a sixth the size.

Answer to the design's driving question: the surgery is **not invasive** in
either engine. Acorn: one append-only insertion per class body, composing
with the export rewrites on the same MagicString with zero coordination.
Native: one `ClassElement` pushed per class body, composing with the
statement-level rewrite ops untouched (the bridge never renumbers
statements). Neither engine's source maps needed special handling — the
native graft zeroes the synthetic spans so codegen's map skips them.

## How the two emissions stay byte-identical

The native engine cannot emit text into the middle of a regenerated module —
codegen prints the whole program its own way. So the CANONICAL member shape
is what oxc codegen prints for the grafted static block, and the acorn
engine's `memberText` replicates that printing by hand (tab indentation,
one-property objects inline, two-property objects broken per property,
block-body setter arrows breaking at the line's depth):

```js
	static {
		Object.defineProperty(this, Symbol.for("wrap-esm-lambda.privates"), { value: {
			"#url": {
				get: (o) => o.#url,
				set: (o, v) => {
					o.#url = v;
				}
			},
			"#pool": { get: (o) => o.#pool }
		} });
	}
```

As with the rest of the rewrite path, byte parity holds on
codegen-conventional sources and is pinned by the parity suite — an oxc
upgrade that changes codegen's formatting fails the suite and drives the
matching `memberText` update.

## Decisions both engines share

Two deliberate departures from the design sketch:

1. **A static block, not a static field.** The sketch's
   `static [PRIVATE_BRIDGE] = {...}` would be an enumerable own property;
   object spread and `Object.assign` copy enumerable symbol keys, so a
   wrapper built by cloning statics would silently carry the bridge. The
   emitted member instead uses `Object.defineProperty` in a static block —
   non-enumerable, non-writable, non-configurable by its defaults. Static
   blocks share the ES2022 baseline with private fields: any parser that
   accepts `#x` accepts `static {}`.

2. **Descriptor-shaped entries, not positional pairs.** A slot exists only
   when the language permits the operation, so the bridge's shape is the
   capability report:
   - field → `{ get, set }`
   - private method or get-only accessor → `{ get }` (writing throws by
     spec, so no setter is offered)
   - set-only accessor → `{ set }`
   - accessor pairs merge; static privates are included as-is (the
     receiver argument is the class itself).

Other contract-relevant behavior pinned by the specs:

- The bridge is reachable from the class binding the patch already receives
  (`bindings.Db[Symbol.for('wrap-esm-lambda.privates')]`), and a subclass
  wrapper inherits it through the static side of the prototype chain — no
  new patch-argument surface was needed. Whether the final surface stays
  this way is still open (the design left it TBD).
- Any planned bridge forces the rewrite path (`code` non-null), even when
  every tapped binding would have taken the append-only fast path.
- Several entries bridging the same class converge on ONE injected static
  block (union of names, first-seen order); empty name lists request
  nothing.
- Refusals throw before any source edit, phrased for `validateConfig` to
  surface ahead of load time — and deliberately NOT worded "not found in
  module", because that exact phrase is the missing-export alarm
  `isMissingExportError` keys the star-graph retry on:
  - `privates: no top-level class named 'X' (top-level classes: ...)`
  - `privates: '#x' not found in class 'X' (available: ...)`
  - `privates: only ESM modules are supported (requested for a CJS module)`

## Scope (the design's "edge cases to decide up front")

Decided:

- **Class shapes reached:** top-level class declarations (exported or not,
  including a _named_ `export default class`) and class expressions
  initializing a top-level `const`/`let`/`var` declarator. Anonymous
  default classes and nested/inner classes have no name to key `privates`
  on — out of scope.
- **Static privates:** bridged as-is; the receiver is the class.
- **Private methods:** readable (the getter returns the callable); never
  writable.
- **Enumerability:** non-enumerable, symbol-keyed (see decision 1).

Still open for the core-plumbing phase:

- Same-name shadowing across multiple classes in one module (first-seen
  wins today; the validator should probably refuse instead).
- The final patch-facing surface (symbol lookup off the binding vs. an
  explicit capability argument) and where the public symbol-key constant
  lives (`PRIVATE_BRIDGE_KEY` is exported from the acorn engine for now;
  core should own it once config plumbing lands).
- Core plumbing: the `privates` config field, `validateConfig` reporting
  (including the version-range warning the design calls for), the corpus
  survey that decides whether this earns its place, and the
  `TAP_CONTRACT_VERSION` 2 → 3 bump — which must land in three places at
  once (core, both engines; engine-parity asserts all three agree).
