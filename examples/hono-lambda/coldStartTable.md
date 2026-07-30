# Cold start by deployment and mechanism — the same app, the same patches

The two deliveries are not two options on the same artifact: bundling
erases the module boundaries the runtime hook's package entries match
(only the handler's own path entry survives in a bundle), and an unbundled
deployment gives the unplugin no build to ride. So the honest question is
per deployment — **what does instrumentation cost the deployment you
already have** — and each group below compares within one artifact.

Measured in ONE session through the real AWS Lambda runtime interface
emulator (`aws-lambda-rie`, linux/amd64 host) answering the example's
`get-quote` event against `app.handler`: five fresh boots per leg, `Billed
Duration` of the first REPORT line, median reported; RSS is the harness
process's own reading after the first response, so every leg is measured
the same way. The orchestrion leg is
[`orchestrion-register.mjs`](orchestrion-register.mjs) —
`@apm-js-collab/code-transformer` instrumenting the same `@smithy/core`
`Client#send` the smithy entry taps, no subscriber attached (the
[hooks bench](../../hooks/benchTable.md) makes the same choice and prices
subscribers separately).

| leg                                            | cold start, billed (median) | in-process RSS (median) |
| ---------------------------------------------- | --------------------------- | ----------------------- |
| `unbundled — no instrumentation`               | 264 ms                      | 81 MB                   |
| `unbundled — runtime hook, oxc engine`         | 315 ms                      | 94 MB                   |
| `unbundled — runtime hook, acorn engine`       | 308 ms                      | 89 MB                   |
| `unbundled — orchestrion (smithy Client#send)` | 344 ms                      | 99 MB                   |
| `bundled — no patches`                         | 194 ms                      | 68 MB                   |
| `bundled — patches baked (unplugin + esbuild)` | 188 ms                      | 68 MB                   |

What the groups say:

- **Unbundled deployment, runtime delivery:** the hook costs **+51 ms /
  +13 MB** (oxc) or **+44 ms / +8 MB** (acorn) over the uninstrumented
  baseline — engine choice is noise-level on this app's cold start.
  Orchestrion instrumenting just the SDK's `Client#send` the same way
  costs **+80 ms / +18 MB**.
- **Bundled deployment, build-time delivery:** the baked patches cost
  **nothing measurable** (−6 ms, inside the noise; identical RSS).
- Context, not an instrumentation number: bundling itself is worth about
  **−70 ms / −13 MB** here (one file versus cold-importing hono and the
  AWS SDK from `node_modules`) — that saving belongs to the packaging
  choice, whichever delivery you use.

The CI Lambda lane re-measures both within-artifact contrasts live on
every push, per runtime image and architecture — the job summary carries
those numbers; this table pins one measured set for the chart.
Regenerate after re-measuring: `node make-chart.mjs` in this directory
(renders `coldStartChart.svg` from this table).
