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
already cover; that is the admission rule ([manifest.mjs](manifest.mjs)),
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

Every package gets the same cells ([run.mjs](run.mjs)):

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

## Findings so far

Shipping the corpus produced four immediately, which is the point of it:

1. **require(esm) of a hook-transformed module, pre-fix-train** — on Node
   22.22.2 / 24.10.0, `require()` of an ESM module whose source a sync load
   hook transformed fails to link its imports (`request for X is from a
module not been linked`); fixed exactly at the
   [nodejs/node#59929](https://github.com/nodejs/node/pull/59929) boundary
   (22.22.3 / 24.11.1) the [interplay matrix](../hooks/interplay-matrix)
   pins for the `Module._load` corridors. Reproduced through five real
   packages (nanoid, chalk, p-limit, execa, lodash-es). The runner now
   requires a post-fix Node and says why.
2. **Same-binding star dedup** — date-fns forwards `longFormatters` through
   two `export *` sources that resolve to the _same_ origin binding. Node
   links it (ResolveExport dedupes identical bindings); the static star walk
   refuses it as ambiguous by provider count. Tracked as an excluded binding
   in the manifest until the walk compares resolved origins.
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

## Running it

```sh
pnpm build && pnpm build:packages   # the addon and the TS packages
node corpus/run.mjs                 # full corpus -> corpus/matrix.md
node corpus/run.mjs zod rxjs        # a subset (prints, does not write)
```

Two schedules in CI ([corpus.yml](../.github/workflows/corpus.yml)):

- **pinned** (push/PR): the versions in `pnpm-lock.yaml` — deterministic; a
  red run means a transform regression.
- **nightly latest**: `pnpm --dir corpus up --latest` first — the
  oxc-monitor analog; a red run means the ecosystem moved (a bundler release
  emitting a new exports shape) and the corpus caught it before a user did.

The committed [matrix.md](matrix.md) is a snapshot from a pinned run;
regenerate it when the corpus or the transform changes. Timing columns vary
by machine — treat them as relative, and watch the typescript row.

## Extending

Add a dependency to `corpus/package.json`, an entry to `manifest.mjs` whose
`notes` say which shape it claims, and (for instrumentation targets) a
`probes/<key>.mjs` + `probes/<key>.config.mjs` + `patches/<key>.mjs` trio.
If the package needs special handling, prefer a manifest knob with a comment
over a special case in the runner — the manifest is the documentation.
