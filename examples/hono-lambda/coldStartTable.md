# Cold start by deployment and mechanism — the same app, the same patches

The two deliveries are not two options on the same artifact: bundling
erases the module boundaries the runtime hook's package entries match
(only the handler's own path entry survives in a bundle), and an unbundled
deployment gives the unplugin no build to ride. So the honest question is
per deployment — **what does instrumentation cost the deployment you
already have** — and each group below compares within one artifact.

Measured through the real AWS Lambda runtime interface emulator
(`aws-lambda-rie`, linux/amd64 host) answering the example's `get-quote`
event against `app.handler`: five fresh boots per leg, **interleaved
round-robin across all six legs** — hyperfine's discipline, because
sequential legs inherit each other's warm page cache and the first cut of
this table measured exactly that artifact (it showed the two engines tied;
interleaved, oxc's real ~20 ms advantage reappears). `Billed Duration` of
the first REPORT line, median reported; RSS is the harness process's own
reading after the first response, so every leg is measured the same way.
The orchestrion leg is
[`orchestrion-register.mjs`](orchestrion-register.mjs) —
`@apm-js-collab/code-transformer` instrumenting the same `@smithy/core`
`Client#send` the smithy entry taps, no subscriber attached (the
[hooks bench](../../hooks/benchTable.md) makes the same choice and prices
subscribers separately). Both bundle legs were built with
`WRAP_ESM_LAMBDA_ENGINE=oxc` — the engine exists only at build time for
the unplugin delivery, and both engines emit byte-identical snippets
(engine-parity.spec.ts), so the bundles' runtime numbers are
engine-independent; the choice is recorded here because provenance should
not have to be inferred.

| leg                                            | cold start, billed (median) | in-process RSS (median) |
| ---------------------------------------------- | --------------------------- | ----------------------- |
| `unbundled — no instrumentation`               | 248 ms                      | 82 MB                   |
| `unbundled — runtime hook, oxc engine`         | 288 ms                      | 94 MB                   |
| `unbundled — runtime hook, acorn engine`       | 308 ms                      | 91 MB                   |
| `unbundled — orchestrion (smithy Client#send)` | 344 ms                      | 99 MB                   |
| `bundled — no patches`                         | 182 ms                      | 68 MB                   |
| `bundled — patches baked (unplugin + esbuild)` | 183 ms                      | 68 MB                   |

What the groups say:

- **Unbundled deployment, runtime delivery:** the hook costs **+40 ms /
  +12 MB** with the native oxc engine, **+60 ms / +9 MB** with the pure-JS
  acorn engine — the ~20 ms between them is the acorn engine importing and
  parsing its own parser (measured in isolation: the native binding loads
  in 0.7 ms and transforms `hono/dist/hono.js` in 0.2 ms; the acorn engine
  costs 37 ms to import and 8 ms for the same transform). Orchestrion
  instrumenting just the SDK's `Client#send` the same way costs **+96 ms /
  +17 MB**.
- **Bundled deployment, build-time delivery:** the baked patches cost
  **nothing measurable** (+1 ms; identical RSS).
- Context, not an instrumentation number: bundling itself is worth about
  **−66 ms / −14 MB** here (one file versus cold-importing hono and the
  AWS SDK from `node_modules`) — that saving belongs to the packaging
  choice, whichever delivery you use.

The CI Lambda lane re-measures both within-artifact contrasts live on
every push, per runtime image and architecture — the job summary carries
those numbers; this table pins one measured set for the chart.
Regenerate after re-measuring: `node make-chart.mjs` in this directory
(renders `coldStartChart.svg` from this table).
