# Changelog

Notable changes to `wrap-esm-lambda` and the `@wrap-esm-lambda/*` packages. The
`0.x` line makes no compatibility promises yet; entries call out anything that
would break a consumer.

## Unreleased

### Fixed — the cold-start comparison measured the wrong thing

- v0.2.2's "runtime hook vs esbuild bundle" contrast compared two
  different deployments and called the whole gap the cost of runtime
  delivery. It isn't: the two deliveries are not substitutes (bundling
  erases the module boundaries the runtime hook's package entries match;
  an unbundled deployment gives the unplugin no build to ride), and about
  half that gap was the bundling win itself. The measurement now prices
  each delivery against its own uninstrumented control on the same
  artifact: `coldStartTable.md` carries a six-leg reference measured
  interleaved round-robin (sequential legs inherit each other's warm page
  cache — the first cut measured exactly that, showing the engines tied) —
  baseline, the runtime hook on both engines, orchestrion instrumenting
  the same `@smithy/core` `Client#send`
  (`examples/hono-lambda/orchestrion-register.mjs`), and plain vs patched
  bundle. Headline: the hook costs +40 ms at cold start with the oxc
  engine and +60 ms with acorn (the gap is the pure-JS engine parsing its
  own parser; orchestrion +96 ms on the same target), baked patches cost
  nothing measurable, and bundling's own ~66 ms saving is a packaging
  fact, not an instrumentation one.
- The CI Lambda lane measures both within-artifact contrasts live (five
  containers, with the uninstrumented controls asserted silent), prints
  both deltas on the job summary and the sticky PR comment, and captions
  the embedded chart as the committed reference so live and reference
  numbers can no longer be mistaken for each other.

## 0.2.2 (2026-07-30)

### Added

- **Build-time delivery joins the hono-lambda example.** `build.mjs`
  bundles both handlers with the unplugin's esbuild adapter and
  `wrap.config.build.mjs` — the runtime config's package entries reused
  verbatim, plus the handler entries written down explicitly (a build
  machine has no `_HANDLER` to discover them from). The `dist/` output
  runs on plain node with no hook, no config and no engine in the
  process; `start:built` / `start:built:consumer` drive it through the
  RIC's load sequence locally.
- **The delivery contrast, billed by the platform.** The CI Lambda lane
  boots the bundle in a third container with nothing but
  `LAMBDA_TASK_ROOT` set and puts the two deliveries' cold starts side by
  side on the job summary — what runtime delivery costs (preload, config
  evaluation, engine binding, on-load transforms) against the bundle's
  zero. A committed measurement (`coldStartTable.md`, five emulator boots
  per delivery) feeds `coldStartChart.svg`, embedded in the example
  README and on the release page.

### CI

- Release pages now embed the benchmark charts inline — raw URLs pinned
  to the release's own tag — instead of only attaching them as assets;
  the hono-lambda cold-start chart joins the attached set.

## 0.2.1 (2026-07-30)

No changes to the published packages — this release is the practical
proof-of-composition and the platform accounting to go with it.

### Added

- **`examples/hono-lambda`** — a [Hono](https://hono.dev/) app on AWS
  Lambda instrumented from one config with zero app changes, covering both
  Lambda shapes: HTTP through `hono/aws-lambda`'s `handle()` (the handler
  discovered from `_HANDLER` by the aws-lambda preset and timed per
  invocation, the matched route template captured as OTel's `http.route`
  by a `Hono` subclass rebind), and event-driven (an SQS batch in, an SNS
  publish per record out, the partial-batch `batchItemFailures` contract
  back to the platform) — the SAME `wrap.config.mjs` covers both handlers.
- **The AWS SDK without a LocalStack.** One entry on `@smithy/core`'s
  `Client#send` sees every `@aws-sdk/client-*` operation (S3 under the
  HTTP handler, SNS under the SQS consumer) and short-circuits before
  credentials or network exist — the interception point that instruments
  the SDK is the one that makes an AWS stand-in unnecessary for testing.
- `__test__/hono-lambda.spec.ts` drives the example through the RIC's
  load sequence on every lane, both handler shapes plus the
  inert-outside-Lambda leg.

### CI

- The Lambda lane boots the example on the real
  `public.ecr.aws/lambda/nodejs` images through the runtime interface
  emulator (`.github/scripts/hono-lambda-rie.sh`) — API Gateway events
  against `app.handler`, the SQS batch against `consumer.handler` in a
  second container — and requires every instrumentation layer to have
  spoken in the logs.
- The job summary gains the platform accounting, three views per
  invocation: the REPORT line (real duration and billed milliseconds; its
  `Max Memory Used` merely echoes the configured size — the emulator
  meters time, not memory), the container's cgroup peak (the genuine
  max-memory number a real Lambda would have reported), and the patch's
  in-process wall time and RSS.

## 0.2.0 (2026-07-28)

### Removed — the config surface is tap-only (breaking)

- **Wrap entries are gone.** The second entry kind (`match` + `handler` +
  `wrapper`, the original Lambda-handler transform) is removed from the
  config surface, the matcher, the apply step, the validator and both
  shells; `WrapperSpec`, `WrapEntry` and `transformMatched` are no longer
  exported and `InstrumentEntry` is now an alias of `PatchEntry`. A wrap
  entry translates directly to a patch entry: a `module: { path: [...] }`
  match, `bindings: ['<handler>']`, and a one-line patch function
  `bindings.handler = WrapAwsLambda(bindings.handler)` — with the
  Lambda-specific runtime discovery handled by
  `@wrap-esm-lambda/hooks/aws-lambda`.
- The engine contract (`TransformEngine`) drops
  `transformLambdaWithMapObject`, and `TAP_CONTRACT_VERSION` moves to 2 —
  a core paired with an older engine (or vice versa) refuses the mismatch
  loudly instead of guessing. Both wrap implementations are deleted
  outright: the acorn engine's `wrap.mts` and the native addon's
  `transformLambda*` exports (with their Rust transformer and the
  `oxc`/`oxc_transformer`/`oxc_semantic`/`oxc_traverse` dependencies they
  alone pulled in). The map-chaining machinery stays — the tap's rewrite
  path uses it, now covered by its own unit test.
- **The benchmark story is the tap's.** `pnpm bench` now runs the former
  `bench:patch` suite — the exports tap (both engines, string and
  zero-copy buffer paths) against orchestrion-js and import-in-the-middle
  on the real `@smithy/core` client module, plus cold starts —
  and `pnpm bench:chart` charts those cases. The hyperfine cold-start
  harness (`hooks/bench_hooks.sh`) times the real register entry on both
  engines against a no-op-hook floor and orchestrion. Retired with the
  wrap: the Babel/acorn/swc/regex wrap re-implementations, the swc wasm
  comparison plugin (`swc-plugin-esm-lambda`), the wrap-based loader-hook
  demo scripts and the source-map demos — the research-phase story lives
  in `docs/history.md` and the presentations.

### Engine binding is lazy

- The transform engine (native oxc addon or the pure-JS acorn engine) now
  binds on **first use** instead of at core import. Importing
  `@wrap-esm-lambda/core` — a config file pulling in `definePatches`, a
  build script — loads no engine; a config with nothing to instrument (the
  aws-lambda preset outside Lambda, a builtins-only config) never loads one
  at all, and the runtime shell skips registering its load hook entirely in
  that case. When the config does have file-matched entries,
  `registerConfig` binds the engine at startup, so a missing or mismatched
  `WRAP_ESM_LAMBDA_ENGINE` remains a loud startup failure and the
  native-to-acorn fallback warning still lands at startup.
- Engine loading is now `require()`-based (the first use can sit inside a
  synchronous `registerHooks` load hook): `selectEngine` is synchronous and
  `engineName` is a function — calling it binds the engine if nothing else
  has. Both are minor API breaks for direct consumers of those exports.

### Failure policy

- Instrumentation failures no longer take the host process down. A patch module
  that will not import drops its own entry, a module whose transform throws
  loads untouched, a patch function that throws is contained (at runtime by the
  registered wrapper, in a bundle by a guard emitted with the call), and a
  builtin whose binding moved is skipped. Every case reports once on stderr and
  is retrievable via `instrumentationFailures()`.
- `WRAP_ESM_LAMBDA_STRICT=1` restores the hard failure for all of the above;
  `WRAP_ESM_LAMBDA_DISABLE=1` turns the runtime shell off entirely before the
  config is resolved or the addon loaded; `WRAP_ESM_LAMBDA_DEBUG=1` traces
  engine selection, matches, skips and rewrites.
- A native addon that cannot be loaded degrades to the pure-JS acorn engine
  with a warning instead of throwing out of `--import`. Naming an engine
  (`WRAP_ESM_LAMBDA_ENGINE=oxc`) opts out of the substitution.
- The addon now reports a transform contract version, and core refuses an
  engine that disagrees — a mismatch is treated like an unloadable addon.
- **Behaviour change:** two previously fatal cases are now reported and
  survived by default — a rebind that no-ops on getter-only bundled CJS, and a
  binding missing from a matched module. Set `WRAP_ESM_LAMBDA_STRICT=1` for the
  old behaviour.

### Added

- Patch entries can match by **path** instead of package identity:
  `module: { path: [...] }` (absolute paths match exactly, relative ones as
  suffixes — the `files` rule) for code with no useful package name, such as
  an app's own files. `path` replaces `name` and excludes
  `versionRange`/`files`; `wrap-esm-lambda-validate` checks candidates that
  exist locally and skips the rest as runtime-only.
- `@wrap-esm-lambda/hooks/aws-lambda`: `lambdaHandlerEntries()` derives a
  path-matched patch entry for a Lambda function's own handler from
  `_HANDLER`/`LAMBDA_TASK_ROOT` at preload, reproducing the runtime
  interface client's resolution rules (basename split on the first dot,
  module-root prefix, the `''`/`.js`/`.mjs`/`.cjs` lookup order, first
  property segment as the tapped binding). The original Lambda-handler use
  case now runs entirely on the generic exports tap — no wrap entry, no
  static handler knowledge; outside Lambda the preset emits no entry, so
  the config is inert. Verified end-to-end against the RIC's load sequence
  in `__test__/lambda-generic.spec.ts` and through AWS's real runtime
  interface client on the `public.ecr.aws/lambda/nodejs` images in the CI
  Lambda lane.
- `wrap-esm-lambda-validate` (a `bin` of `@wrap-esm-lambda/core`): checks a
  config against the installed tree — package present, version in range,
  declared files present, ESM exports still there, patch module importable —
  and exits 1 on any error, 2 when the config could not be read at all.

### Packaging

- The four workspace packages are TypeScript (`src/*.mts`) and ship compiled
  ESM plus declarations, so `definePatches` and friends are typed for
  consumers.
- `chart.js` moved out of the published addon's runtime dependencies; it was
  only ever used by the benchmark chart scripts.
- The native addon became an _optional_ dependency of `@wrap-esm-lambda/core`,
  which the acorn fallback makes safe.
- `engines.node` now states what is actually tested (>= 22, and >= 22.15 for
  `@wrap-esm-lambda/hooks`).

### CI

- The suite runs on Node 22, 24 and 26 across linux-x64, linux-arm64,
  linux-x64-musl, linux-arm64-musl, win32-x64-msvc and darwin-arm64, plus the
  WASI build and a lane with no native artifact at all. Both engines run on
  every native lane.
- Gates added: `clippy -D warnings`, `oxlint --deny-warnings`,
  `prettier --check`, `tsc --noEmit` over the specs, and a pack-and-install
  check that the published tarballs actually work.
- Benchmarks no longer run in the publish job, and publishing to npm requires a
  manual workflow dispatch with an explicit confirmation.
