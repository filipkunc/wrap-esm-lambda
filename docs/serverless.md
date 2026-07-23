# Serverless soundness: AWS Lambda and Azure Functions

Runtime instrumentation of managed platforms was historically blocked by
broken Node module-loading functionality (the issue trail in
[history.md](history.md)), so the runtime shell's soundness on those
platforms is checked empirically, not assumed. What
[hooks/interplay-matrix](../hooks/interplay-matrix) verifies across the
Node 22/24/26 ladder — including every pre-fix minor:

- **Delivery**: on managed runtimes you don't own the node CLI. Lambda
  injects flags via the `NODE_OPTIONS` env var; Azure Functions passes
  worker args via the `languageWorkers__node__arguments` app setting. The
  matrix registers the hook purely through `NODE_OPTIONS=--import` — OK on
  every rung.
- **Bootstrap ordering**: both platforms boot a CJS bundle first (Lambda's
  runtime interface client, Azure's node worker) and load the user handler
  late — `import()` for ESM, `require()` for CJS. The matrix's
  `tap-bootstrap-*` columns simulate exactly that shape — OK on every rung,
  both module systems, both sides of the fix train.
- **The broken window itself**: the tap never touches `Module._load`, so the
  22.15.0–22.22.2 / 24.10.0–24.11.0 interplay bugs that blinded
  patch-based instrumentation don't reach it.

Platform version reality (mid-2026): Lambda offers `nodejs22.x` and
`nodejs24.x` ([runtimes table](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html));
Azure Functions host 4.x offers Node 20 and 22 (Node 20 support ends
April 2026, Node 22 runs to April 2027, programming model v4 —
[supported languages](https://learn.microsoft.com/en-us/azure/azure-functions/supported-languages)).
Both vendors apply Node _minor_ updates on their own cadence behind
nodejs.org, and neither publishes the embedded minor — so whether a given
deployment sits before or after the v22.22.3 / v24.11.1 fix train can only
be answered by logging `process.version` in a live function. The matrix
exists precisely so that the answer doesn't matter for this library: the
tap behaves identically on both sides.

Two honest caveats remain. First, on a pre-fix minor, registering _any_
sync hook — ours included — triggers the `Module._load` blinding for
`import`-ed CJS, which can degrade a _coexisting_ patch-based agent (Azure
App Insights' `diagnostic-channel`, classic APM agents) until the platform
crosses the fix train; that is an interaction to know about, not a failure
of either tool alone. Second, when the platform minor is unverifiable and
the risk budget is zero, the build-time shell
([`@wrap-esm-lambda/unplugin`](../packages/unplugin)) delivers byte-identical
instrumentation with no runtime loader machinery at all — the hybrid design
is itself the mitigation for the next loader regression.
