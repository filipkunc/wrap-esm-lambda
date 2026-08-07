# Design: declarative private-state exposure (`privates`)

Status: proposal, not implemented. Drafted 2026-08-07 from a working session
that validated the runtime side of the patching model against 0.3.0 preview
builds; this document is the handoff for the implementation session.

## The limitation

The declarative tap hands patches the module's **live bindings** — and that
surface has proven out well beyond plain functions. A minimal APM demo
built on the 0.3.0 preview packages confirmed, against both engines:

- **Function bindings**: rebinding intercepts even intra-module calls
  (`fetchQuote` calling `getQuote` through the live binding), which
  `Module._load`-style export patching can never reach.
- **Classes**: `bindings.Db = class Db extends Original { … }` intercepts
  construction with `new` semantics, the prototype chain, `instanceof`, and
  `constructor.name` all intact — including the library's own internal
  `new Db(...)` sites, again via the live binding.
- **Methods and accessors**: ordinary prototype surgery; a
  `getOwnPropertyDescriptor`/`defineProperty` wrap of a getter/setter pair
  delegates with `.call(this)`, and **private-field-backed accessors keep
  working** because the receiver is a genuine branded instance (the subclass
  wrapper's `super()` runs the original constructor).

What none of that can reach is private state itself. `#field` is
brand-scoped to the class body's lexical scope; there is no reflection
escape hatch, and the patch executes outside that scope like everyone else.
State that no public constructor, method, or accessor exposes — a `#socket`,
a `#cache` — is genuinely out of reach **at runtime**. This is the one
boundary the bindings model cannot cross, ever, by language guarantee.

But this toolkit is a source-transform engine: it owns the AST before
evaluation, where `#field` is just syntax. The transform layer is not _a_
way across the brand boundary — it is the only way that exists.

## The proposal

Do **not** open the AST to patch authors. Keep the toolkit's philosophy —
config declares _what_, engines handle _how_, patches stay plain imperative
code — and add one declarative field:

```js
{
  module: { name: 'some-lib', versionRange: '^2.3.0', files: ['db.mjs'] },
  patch: { name: 'traceDb', from: './patches/db.mjs' },
  bindings: ['Db'],
  privates: { Db: ['#url', '#pool'] },   // NEW: class name -> private names
}
```

Seeing `privates`, the engine injects into the named class's body — the one
place the brand is legal — a static member keyed by a well-known symbol,
holding get/set closure pairs:

```js
static[PRIVATE_BRIDGE] = {
  '#url': [
    (o) => o.#url,
    (o, v) => {
      o.#url = v
    },
  ],
  '#pool': [
    (o) => o.#pool,
    (o, v) => {
      o.#pool = v
    },
  ],
}
```

The patch receives the bridge as an additional capability (surface TBD —
e.g. a second argument, or reachable from the class binding via the symbol):
real get/set on genuine instances, no Proxy traps, no brand violations. The
patch author contract stays exactly what it is today.

## Implementation notes (why this is real work)

- **Engine parity, byte-identical.** Both engines must emit the identical
  bridge member; this is enforced by `__test__/engine-parity.spec.ts` and is
  a `TAP_CONTRACT_VERSION` bump (currently 2). The existing tap snippet is
  appended at module end; this injection lands _inside_ a class body — real
  AST surgery in the Rust rewrite path (`src/transform/rewrite.rs`) and in
  the acorn engine (`packages/engine-acorn`, `tap.mts`), with honest
  source-map chaining through it (see `docs/source-maps.md`).
- **Suggested sequencing:** prototype the acorn-engine injection first to
  learn how invasive the class-body surgery is, then port to the Rust
  engine, then bump the contract. The acorn side is cheap to iterate
  (magic-string over an acorn AST) and the parity suite will drive the Rust
  port.
- **Validation belongs in `validateConfig`.** The transform knows at rewrite
  time whether `#url` exists in the class body; a missing private should be
  a validation-time report (the validator's whole purpose is surfacing
  load-time refusals ahead of time — same as the star-ambiguity work in
  0.3.0), not a runtime `undefined`.
- **`versionRange` stops being optional in spirit.** Private names are not
  API; libraries rename them in patch releases with a clear conscience. The
  validator should warn when a `privates` entry lacks a version range.
- **Edge cases to decide up front:** multiple classes per module with the
  same exported name (shadowing), class expressions vs declarations,
  privates on nested/inner classes, static privates (`static #x`), private
  methods (`#m()`) vs fields, and whether the bridge should be enumerable
  to reflection (it should not — symbol-keyed, non-enumerable).
- **Precedent and framing.** Orchestrion (benchmarked in
  `docs/comparisons.md`) is the "rewrite the function body" school; this is
  that move kept declarative and scoped. The honest answer to "isn't this
  breaking encapsulation?" is yes, deliberately, in a named, versioned,
  auditable place — the config names exactly which privates open up.

## Before building: measure demand

Most real APM needs are already served by the choke points the bindings
model owns (constructor args, method boundaries, accessors — the setter
wrapper already decides what gets _stored in_ a private field, and the
constructor wrapper decides its initial value). The cases that need the
bridge are privates no public surface exposes. The corpus harness
(`corpus/`) is the instrument for deciding whether this earns its
contract-version bump: survey how often popular packages hide
instrumentation-relevant state behind privates with no public accessor.

## Context from the working session (for the record)

- 0.3.0 is tagged and released on GitHub with all platform binaries;
  npm publish remains deliberately disarmed (manual dispatch + typed
  confirmation).
- Continuous previews are live: every green push publishes installable
  tarballs via pkg.pr.new (step in CI.yml's publish job; the pkg.pr.new
  GitHub App is installed). Install pattern:
  `npm i https://pkg.pr.new/filipkunc/wrap-esm-lambda/@wrap-esm-lambda/hooks@<sha>`
  — sibling deps including the napi platform packages resolve automatically.
- The validating micro-demo (lib.mjs / main.mjs / apm.mjs / apm-patch.mjs)
  ran green on both engines; the acorn engine is the JS-only path
  (`WRAP_ESM_LAMBDA_ENGINE=acorn`), and an explicitly requested engine is
  never silently substituted.
