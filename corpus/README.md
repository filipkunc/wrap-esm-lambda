# The ecosystem corpus

Popular npm packages run through the exports tap on every push — the
[oxc](https://oxc.rs/)-style ecosystem suite, adapted to what this project
actually has to survive. oxc's monitor works because its check is cheap and
self-verifying (parse, print, assert nothing broke — no running app); the
corpus equivalent is the **identity patch**: tap a package over its full
statically visible export surface with a patch that does nothing, then
assert the patch ran and a consumer observes an unchanged package.

Results: [matrix.md](matrix.md) (generated). Current corpus: ~27 packages,
~180 subprocess cells, a couple of minutes on a laptop.

## Curation: shapes, not download rank

Raw top-N lists cluster by build tool — mostly redundant rollup/tsup output.
Each corpus entry has to claim an **artifact shape** the table does not
already cover; that is the admission rule ([manifest.mts](manifest.mts)),
and it is what keeps the corpus small enough to run on every push:

- **handwritten CJS** — lodash (one file, ~640 properties), debug/ms
  (`module.exports` _is_ the function), pg (a lazy getter that must not be
  eagerly evaluated), react (entry picks prod/dev at require time),
  graceful-fs (monkey-patches fs itself — another patcher in the room)
- **transpiled / machine-generated CJS** — ioredis (`exports.default` +
  `__esModule` interop), mongodb (large class-heavy tsc output), typescript
  (the perf stress row: one enormous file, 2200+ bindings, transform time
  tracked in the table)
- **dual packages and exports maps** — zod, axios (self-referencing default
  aliases), date-fns (per-function files behind a huge map), vue (see
  findings), uuid/nanoid, graphql (`.js`/`.mjs` side by side per module)
- **ESM-only and barrels** — lodash-es (~640 re-exports split at volume),
  rxjs, chalk/execa/p-limit (pure ESM, require(esm) consumers)
- **instrumentation-realistic targets** — undici, mysql2, redis, koa, knex,
  pg, ioredis, mongodb, graphql, and @nestjs/core — the packages
  observability patches actually get written for

Deliberate exclusions are documented at the bottom of the manifest
(express/fastify/hono/smithy live in `__test__/*.spec.ts` one-per-shape;
Next/Angular are hosts, not tap targets; googleapis-class packages are
excluded for install weight; native addons have no source to tap).

## The battery

Every package gets the same cells ([run.mts](run.mts)):

| cell          | asserts                                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **enumerate** | both entry conditions resolve, the surface enumerates, and the real transform pipeline (star walk included) runs — tier and timing land in the table                                                                 |
| **import**    | ESM consumer, control vs runtime-hooked: patch ran, export-surface fingerprint unchanged                                                                                                                             |
| **require**   | the same through `require()` — require(esm) for pure-ESM packages                                                                                                                                                    |
| **build**     | esbuild + the unplugin, same config: the bundled app observes the same, patched surface                                                                                                                              |
| **hybrid**    | the instrumented bundle run again _under_ the runtime hook: the sentinel holds the patch count at exactly one                                                                                                        |
| **probe**     | (instrumentation tier) a real two-line patch observed through the package's public API — wraps `pg` `Client#query`, builds SQL through a rebound knex factory, serves a request through Nest into patched express, … |

Fingerprints compare types/names/arities, never identities or live values,
so they are stable across processes; lazy getters that throw must throw
identically with and without the tap. Two corpus-wide alarm checks pin the
loud half of the contract: a missing binding must be a **hard error**
(version-drift alarm), a non-matching `versionRange` must be **inert**.

Deviations from the manifest's expected outcomes fail the run — a known,
documented outcome is encoded in the manifest, so the matrix distinguishes
"finding" from "regression".

The corpus itself is TypeScript (`.mts`/`.cts`) running on Node's **native
type stripping** — no loader, no build step; the runner's Node floor
(>= 22.22.3, below) is past the 22.18 line where stripping is on by
default, and `corpus/tsconfig.json` pins `erasableSyntaxOnly` so whatever
typechecks is guaranteed runnable by stripping alone. One file is
deliberate JavaScript: `lib/consumer-require.cjs` (see finding 5).

## Findings so far

Shipping the corpus produced seven immediately, which is the point of it:

1. **require(esm) of a hook-transformed module, pre-fix-train** — on Node
   22.22.2 / 24.10.0, `require()` of an ESM module whose source a sync load
   hook transformed fails to link its imports (`request for X is from a
module not been linked`); fixed exactly at the
   [nodejs/node#59929](https://github.com/nodejs/node/pull/59929) boundary
   (22.22.3 / 24.11.1) the [interplay matrix](../hooks/interplay-matrix)
   pins for the `Module._load` corridors. Reproduced through five real
   packages (nanoid, chalk, p-limit, execa, lodash-es). The runner now
   requires a post-fix Node and says why.
2. **Same-binding star dedup** (found, then **fixed**) — date-fns forwards
   `longFormatters` through two `export *` sources that resolve to the
   _same_ origin binding. Node links it (ResolveExport dedupes identical
   resolutions); the static star walk refused it as ambiguous by provider
   count. Both engines now report re-export provenance (explicit
   re-exports, namespace re-exports, import-backed list exports) and the
   walk compares providers by transitive origin — same binding resolves,
   genuinely different origins stay a loud refusal naming both origins.
   Pinned by `__test__/stars-dedup.spec.ts` under both engines; date-fns
   runs at full surface in the corpus again.
3. **`export *` from a CJS file as a package's entire import condition** —
   vue's `index.mjs` is one line: `export * from './index.js'` (CJS). A star
   into CJS is statically invisible (documented loud limit), and vue shows
   the shape shipping at scale. The corpus taps vue's CJS defining entry
   instead — both consumer routes observe the patch, because the ESM wrapper
   loads that entry underneath ("prefer the defining module",
   operationalized).
4. **Lexer widening** (benign, recorded per package in the matrix notes) —
   appending `module.exports.X` accessor writes makes cjs-module-lexer
   discover named exports it previously missed, so an import-of-CJS
   namespace can _gain_ names under the tap (lodash: +307). The names are
   real properties with correct values; consumers gain imports, lose
   nothing.
5. **Type-stripped entry × require(esm)-of-transformed** (found by this
   corpus's own TypeScript conversion) — a **type-stripped CJS entry**
   (`.cts`) that `require()`s a hook-transformed ESM module fails to link
   (`request for X is from a module not been linked`) on the whole 22.x
   line, **including 22.23.1, past the #59929 fix train**; fixed on
   24.18.0 / 26.x. Only the _entry_ triggers it — a stripped `.cts` helper
   under a plain `.cjs` entry works everywhere (which is why
   `lib/fingerprint.cts` is TypeScript and `lib/consumer-require.cjs` is
   not). A candidate scenario for the
   [interplay matrix](../hooks/interplay-matrix).
6. **Next.js cannot boot under sync-hook instrumentation on Node 22.x** —
   `next/dist/build/next-config-ts/require-hook.js` reads
   `require.extensions['.js']` at module top level (a pirates-style
   transpile hook), and on the whole 22.x line, CJS loaded in a sync-hook
   context gets the **re-invented require without `extensions`** — the
   interplay matrix's `import-cjs-synthetic-require` BARE_REQUIRE column,
   the [nodejs/node#62786](https://github.com/nodejs/node/issues/62786)
   class, here shipping inside the most popular framework there is. Fixed
   territory on 24.11.1+ (both host scenarios pass on 24.18.0); the host
   harness skips loudly on older Nodes and the corpus CI job runs Node 24.
7. **A quadratic star walk** (found by this benchmark, then **fixed in
   core**) — date-fns' generated barrel is 245 `export * from` statements
   and no own exports, and the corpus taps all 250 forwarded bindings.
   `resolveStarBindings` asked "which source provides this name?" once per
   name, re-walking the whole graph each time: ~61k provider probes,
   **~90ms of a ~99ms transform**, over files the parse cache had already
   read. (The first write-up of this table called that row "fs-bound";
   measuring it showed reading and parsing all 245 sources is only ~9ms.)
   The walk now indexes the graph once into name → providers, which is
   O(sources + names): the row went **98.7ms → 9.2ms** and stopped scaling
   with the binding count (250 bindings cost about what 1 does). Only
   configs that tap a bare-`export *` barrel paid it, and the corpus's
   whole-surface tap is the pathological case — a normal 1–3 binding entry
   paid ~6ms — which is exactly why it took a corpus to surface.

## Hosts: Next.js (SSR and the dev server)

Platforms that own their module graph — Next.js — are **hosts, not tap
targets**: the corpus never patches Next, it patches an ordinary
server-side dependency (`ms`) and asserts a server-rendered request crossed
it, with the hook delivered the way managed runtimes deliver it —
`NODE_OPTIONS` preload, which reaches every worker the host forks.
[hosts/nextjs](hosts/nextjs) is a minimal pages-router app whose
`getServerSideProps` calls the patched dependency and renders the patch
counter into the HTML; [lib/hosts.mts](lib/hosts.mts) drives two scenarios
and the results land in matrix.md's Hosts table:

- **`next start` (SSR)** — `next build` runs unhooked (the build process is
  not the target), then the production server serves the probe page.
- **`next dev` (SSR, dev server)** — the same page through the dev server's
  compile-on-demand pipeline. This is the honest answer to "does it work
  with the dev server": server-side dependencies, yes, same delivery; the
  **client/HMR module graph stays out of scope by design** — dev-mode
  module identity churns, and instrumenting it answers no production
  question (the validate CLI's dry-run report is the right tool for
  "will my config land" during development).

## Engine benchmark

[bench.mts](bench.mts) runs the same full-surface identity tap once per
engine — native oxc vs pure-JS acorn, one process each because the engine
binds process-wide — and writes [engines.md](engines.md) plus
[engines.svg](engines.svg), a dumbbell dot plot (one row per ESM entry,
two dots on a log time axis — the gap between the paired dots is the
ratio; series are double-encoded by color and dot shape). The results are
**split by module mode**, because only ESM is an engine comparison: in CJS
mode the tap ignores the input by design (no parse, no validation —
accessors appended sight-unseen through the same registerHooks source
pipeline; `Module._load` is never touched), so CJS rows tie by
construction and live in their own plumbing-sanity table. Timing is the
**minimum** of repeated runs (the work is deterministic and CPU-bound;
shared-runner allocation jitter was observed turning an 8.8MB
`Buffer.concat` into anything from 2ms to 578ms, so a median of few samples
is noise). Two headline results from the pinned corpus:

- **ESM (the engine comparison): acorn ~5.2× slower geomean, 3.1× summed**
  — parse, per-binding validation and the rewrite tier are where the
  engines genuinely differ, and the biggest rewrite gaps run 4–8× (nanoid,
  execa, chalk, uuid, pg's esm wrapper). Consistent with the ~6× figure in
  [docs/benchmarks.md](../docs/benchmarks.md): the native edge lives where
  parsing lives. The engines converge on the date-fns barrel, whose cost is
  dominated by reading and parsing its 245 star sources rather than by the
  tap itself — but see finding 7 for how much of that row used to be
  something else entirely.
- **CJS (plumbing sanity): geomean ~1.0×, the expected tie** — no parse
  happens in CJS mode, so these rows verify the shared byte pipeline
  rather than race the engines; a gap here would be a plumbing bug.
- The bench doubles as the widest **byte-parity check** available:
  append-tier output (source + snippets, promised byte-identical) is
  asserted hash-equal per entry and holds corpus-wide. Rewrite-tier output
  is _engine-styled_ by construction — oxc regenerates through codegen
  (normalized formatting), acorn edits via magic-string (original
  formatting preserved) — so it is reported, not asserted; semantic parity
  of the rewrite is covered by the identity battery, which passes under
  either engine (`WRAP_ESM_LAMBDA_ENGINE=acorn node corpus/run.mts`).

## Running it

```sh
pnpm build && pnpm build:packages   # the addon and the TS packages
node corpus/run.mts                 # full corpus -> corpus/matrix.md
node corpus/run.mts zod rxjs        # a subset (prints, does not write)
node corpus/bench.mts               # engine shoot-out -> corpus/engines.md
pnpm exec tsc --noEmit -p corpus/tsconfig.json   # typecheck (stripping does not)
```

Two schedules in CI ([corpus.yml](../.github/workflows/corpus.yml)):

- **pinned** (push/PR): the versions in `pnpm-lock.yaml` — deterministic; a
  red run means a transform regression.
- **nightly latest**: `pnpm --dir corpus up --latest` first — the
  oxc-monitor analog; a red run means the ecosystem moved (a bundler release
  emitting a new exports shape) and the corpus caught it before a user did.

**Where results show up.** The committed [matrix.md](matrix.md),
[engines.md](engines.md) and [engines.svg](engines.svg) are snapshots: they
change only when somebody runs the commands and commits, which is right for
files people read in the repo but says nothing about a given run. So every
run ALSO appends its report to the GitHub job summary when one exists
(`$GITHUB_STEP_SUMMARY`, see [lib/publish.mts](lib/publish.mts)) — the
tables render on the workflow run page of every PR that touches the corpus,
with no commit, no bot comment, and no per-runner timing noise in the diff.
The chart is not inlinable there, so the summary copy points at the run's
`corpus-results` artifact, which carries both tables and the SVG.

Regenerate the committed snapshots when the corpus or the transform
changes. Timing columns vary by machine — treat them as relative, and watch
the typescript and date-fns rows.

## Dependencies are fixtures, not shipped code

Every package the corpus lists lives in **`devDependencies`**, deliberately:
`wrap-esm-lambda-corpus` is `private: true` and never published, so its
packages are test fixtures rather than dependencies of anything a user
installs. That classification is what keeps the repo's security gate
meaningful — `pnpm audit --prod` blocks on the **published** tree, the dev
tree only warns (see `.github/scripts/audit-report.mjs`). Filing fixtures as
production dependencies would let any advisory in any corpus package veto an
unrelated PR, and "a gate that is always red is a gate everybody learns to
ignore."

Fixtures still must not drag known-vulnerable code into a CI runner, so
where a patched version exists inside the same major it is pinned in
`pnpm-workspace.yaml`'s `overrides` (currently `postcss` and `sharp`, both
reached only through Next's tree) rather than allowlisted.

## Extending

Add a dependency to `corpus/package.json`, an entry to `manifest.mts` whose
`notes` say which shape it claims, and (for instrumentation targets) a
`probes/<key>.mts` + `probes/<key>.config.mts` + `patches/<key>.mts` trio.
If the package needs special handling, prefer a manifest knob with a comment
over a special case in the runner — the manifest is the documentation.
