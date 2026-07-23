# `wrap-esm-lambda`

![https://github.com/filipkunc/wrap-esm-lambda/actions](https://github.com/filipkunc/wrap-esm-lambda/workflows/CI/badge.svg)

## Wrapping AWS Lambda ESM `handler`

The problem: How to transform AWS Lambda `handler` below?

```js
// input.js
export const handler = async (event) => {
  return 'Hi from AWS Lambda'
}
```

To the following, notice the `WrapAwsLambda` wrapper:

```js
// transformed.js
export const handler = WrapAwsLambda(async (event) => {
  return 'Hi from AWS Lambda'
})
```

Wrapping uses [async and sync loader hooks from Node.js](https://nodejs.org/api/module.html#customization-hooks).

This library uses [napi.rs](https://napi.rs/) and [oxc.rs](https://oxc.rs/).
For comparison the minimal wrapping code is re-implemented using [Babel](https://babeljs.io/), [Acorn](https://github.com/acornjs/acorn), [swc.rs](https://swc.rs/) and [orchestrion-js](https://github.com/nodejs/orchestrion-js) (via a custom `addTransform` operator, plus its stock `diagnostics_channel` tracing transform for reference).

## Usage

1. Run `pnpm install` to install dependencies.
2. Run `pnpm build` to build.
3. Run `pnpm test` to run Node binding tests with [`ava`](https://github.com/avajs/ava)
4. Run `cargo fmt` and `cargo clippy` before committing
5. Run `cargo test` to run Rust tests

### Source maps

Wrapping the handler shifts its lines: an exception then reports the position in
the transformed code, not the original file. `transformLambdaWithMap` fixes this
by asking oxc to also emit a source map, appended to the output as an inline
`//# sourceMappingURL=` data URL. The wrapped handler body keeps its original
spans, so under Node's `--enable-source-maps` a thrown error resolves to the
original line.

```js
import { transformLambdaWithMap } from 'wrap-esm-lambda'
const source = transformLambdaWithMap(originalSource, 'handler', 'WrapAwsLambda', 'handler.mjs')
```

A runnable before/after demo is in [hooks/sourcemap-demo](hooks/sourcemap-demo):

```sh
./hooks/sourcemap-demo/run.sh
```

The handler throws on line 11, but codegen strips the blank lines above it. Without
a map the stack points at line 4 (a comment); with the oxc map it points back at
line 11:

```
=== WITHOUT source map (plain transformLambda) ===
Error: boom for 42
    at handler-throws.mjs:4:8

=== WITH oxc source map (transformLambdaWithMap) ===
Error: boom for 42
    at handler-throws.mjs:11:9
```

Emitting the map is cheap: on a small handler the transform goes from ~2.9 µs to
~4.2 µs, so even with a map oxc is faster than acorn without one.

#### Chaining back to TypeScript

If the handler started as TypeScript, `tsc` already produced `handler.js` plus a
`handler.js` -> `handler.ts` map. Our wrap adds a second step, so its map only
reaches `handler.js`. To get an exception all the way back to the `.ts`, compose
the two maps. oxc's map is `transformed -> handler.js`; chain it through the tsc
map with [`@ampproject/remapping`](https://github.com/ampproject/remapping)
(synchronous, so it works inside a `registerHooks` load hook).
`transformLambdaWithMapObject` returns the raw map for this:

```js
import remapping from '@ampproject/remapping'
import { transformLambdaWithMapObject } from 'wrap-esm-lambda'

const { code, map } = transformLambdaWithMapObject(jsSource, 'handler', 'WrapAwsLambda', 'handler.js')
const chained = remapping(map, (file) => (file.endsWith('handler.js') ? tscMap : null)).toString()
// `chained` now maps transformed -> handler.ts; inline it as a data URL
```

Demo in [hooks/sourcemap-ts-demo](hooks/sourcemap-ts-demo) (`./run.sh` compiles
the `.ts` first). The handler throws on line 15 of `handler.ts`; without chaining
the stack stops at the generated `handler.js`, with chaining it reaches the `.ts`:

```
=== wrap with NON-chained map (transformed -> handler.js only) ===
Error: boom for 42
    at handler.js:4:11

=== wrap with CHAINED map (transformed -> handler.js -> handler.ts) ===
Error: boom for 42
    at handler.ts:15:9
```

The compose costs ~22 µs on top of the transform (the map JSON round-trips through
`remapping`), still well under a single Babel transform and paid once per module.

#### Composing the maps in Rust instead of `remapping`

The compose itself doesn't need JS at all: `transformLambdaWithChainedMap` takes
the upstream tsc map JSON and traces the wrap map through it in Rust, using
`oxc_sourcemap`'s token lookup (the same trace `remapping` performs). The wrap
map never leaves Rust — no serialize-to-JSON, cross napi, re-parse round-trip —
so the whole wrap-and-chain runs in one call:

```js
import { transformLambdaWithChainedMap } from 'wrap-esm-lambda'

// tscMap: the handler.js -> handler.ts map tsc emitted
const source = transformLambdaWithChainedMap(jsSource, 'handler', 'WrapAwsLambda', 'handler.js', tscMap)
// `source` has an inline map already reaching handler.ts
```

(`transformLambdaWithChainedMapObject` returns `{ code, map }` instead of
inlining, mirroring `transformLambdaWithMapObject`.)

This is ~2.5x faster end-to-end than composing with `remapping`: ~11 µs vs
~27 µs for wrap + chain (the compose step drops from ~23 µs to ~7 µs). The
result is byte-for-byte equivalent in effect — the demo's third variant
(`sync-hooks-oxc-ts-rust.mjs`) resolves the same `handler.ts:15:9`:

```
=== wrap with CHAINED map composed in Rust (oxc_sourcemap, no remapping) ===
Error: boom for 42
    at handler.ts:15:9
```

### Hybrid instrumentation: runtime or build time

The same native transform can run at two very different moments, and the
[packages/](packages) workspaces build both shells around one shared core so
users pick per deployment — not per codebase:

- [`@wrap-esm-lambda/core`](packages/core) — the shared piece: one declarative
  config (`defineConfig`), one matcher, one `transformMatched` call. Because
  both shells delegate to it, the instrumented output is byte-identical
  whichever mode produced it.
- [`@wrap-esm-lambda/hooks`](packages/hooks) — **runtime**: a synchronous
  `registerHooks` load hook, activated with
  `node --import @wrap-esm-lambda/hooks/register` and a config path in
  `WRAP_ESM_LAMBDA_CONFIG`. Zero build changes; per the cold-start table the
  native transform keeps the overhead in the ~2 ms range.
- [`@wrap-esm-lambda/unplugin`](packages/unplugin) — **build time**: the same
  transform behind [unplugin](https://unplugin.unjs.io/), giving
  Vite/Rolldown, Rollup, esbuild, webpack and Rspack adapters from one file.
  Modules are wrapped before bundling (path matching still works) and the
  bundler composes the returned source map; the deployed artifact is
  pre-instrumented, so cold start pays nothing.

Every transformed module ends with a `/*! @wrap-esm-lambda instrumented */`
legal comment (bundlers keep those), and both shells skip sources that carry
it — enabling both modes at once never double-wraps. (Detection keys on the
comment's inner text: esbuild's legal-comment hoisting rewrites the
delimiters, which would silently defeat a full-comment match.)
[`__test__/hybrid.spec.ts`](__test__/hybrid.spec.ts) runs one fixture through
both modes end-to-end, checks the outputs match, and layers the runtime hook
on a build-time instrumented bundle to prove the guard.

#### Declarative patches: the exports tap

The second entry kind generalizes this into `Module._load`-monkey-patching
ergonomics, delivered by source transform instead of loader interception. A
patch entry names a package (with a semver range and the files inside it), the
exports to hand over, and a plain TypeScript function the user writes:

```ts
// wrap.config.ts
export default definePatches([
  {
    module: {
      name: '@smithy/core',
      versionRange: '>=3 <5',
      files: ['dist-es/submodules/client/smithy-client/client.js', 'dist-cjs/submodules/client/index.js'],
    },
    patch: { name: 'patchSmithyClient', from: '/abs/path/patches/aws.ts' },
    bindings: ['Client'],
  },
])

// patches/aws.ts — ordinary imperative code against live objects
export function patchSmithyClient({ Client }) {
  const orig = Client.prototype.send
  Client.prototype.send = async function (command, ...rest) {
    // spans, diagnostics_channel.publish, whatever — then:
    return orig.call(this, command, ...rest)
  }
}
```

The oxc side is one generic transform: validate the requested exports (a
missing export is a hard error — the version-drift alarm), then _append_ a
call handing the patch function the module's live bindings as get/set
accessors — so the patch can mutate prototypes or even rebind a
`function`/`class`/`let` export, with the same reach `Module._load` patching
ever had, in ESM and CJS alike. Appending keeps every original line (and any
source map) intact, and the call runs at the end of the module's own
evaluation: after its definitions exist, before any importer sees them.

Patch delivery differs per mode: at build time a static import is appended
and the bundler bundles the patch code; at runtime no import is injected at
all — the register entry preloads patch functions into a
`Symbol.for('wrap-esm-lambda.patches')` global registry the tap reads,
because hook-overridden CJS sources cannot serve an injected `require`.

[`__test__/aws.spec.ts`](__test__/aws.spec.ts) proves it against the real
AWS SDK: every `@aws-sdk/client-*` operation funnels through `Client#send`
in `@smithy/core`'s client submodule, so the single entry above intercepts
`S3Client`'s `PutObjectCommand` — through the runtime hook on the SDK's
bundled `dist-cjs` and through esbuild on its `dist-es`, same patch code.
[`__test__/patch.spec.ts`](__test__/patch.spec.ts) covers the mechanics on a
fixture package (emission shapes, loud failures, version-range gating, CJS
getter-only exports, the double-patch guard).

The patch module itself is ordinary user code and may carry its own
dependency graph — relative TypeScript helpers and bare npm specifiers work
identically in both modes, with one documented exception (importing the
instrumented package at the patch's top level). The full rules live in the
[patch author contract](packages/core/README.md#patch-author-contract),
each backed by a test in `patch.spec.ts`.

#### Built-ins: `node:http` and friends

Source transforms cannot reach built-ins — `node:http` has no source for a
load hook or bundler to rewrite — and the classic answer was `Module._load`
interception. The matrix measures what that dependence is actually worth:
`require('node:http')` through `Module._load` survived every rung including
the broken window, but `import 'node:http'` has **never** flowed through
`Module._load` on any version — the patch point was never sufficient for ESM
consumers by design. So a builtin strategy needs neither loader hooks nor
the patch point: a declarative config knows its targets up front, and the
runtime shell patches them **eagerly at preload**, mutating the builtin's
exports object before any user code loads:

```ts
export default definePatches([
  {
    module: { name: 'node:os', versionRange: '>=22' }, // range gates on process.versions.node
    patch: { name: 'patchOs', from: '/abs/patches/os.mjs' },
    bindings: ['hostname'],
  },
])
```

The patch function gets the same get/set accessor object as the exports tap,
backed by the builtin's live exports. Because the ESM facade of a core
module is created at its first import — which preload precedes — `require()`,
ESM default import and ESM named import all observe the patch: the matrix's
`builtin-eager-patch` column is PATCHED_ALL on every rung, broken window
included. A missing binding fails loudly at preload (the version-drift
alarm), and builtin entries are runtime-only: they never match a file path,
so the build-time shell cannot silently claim them — bundle-time
instrumentation of core modules is impossible in principle.

(For observe-only needs on core modules, Node's own
[`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
tracing channels for http and friends are the sanctioned alternative — no
patching at all; the eager patch is for when you need to wrap or rebind,
the same reach split as the orchestrion comparison below.)

#### Real packages: express, fastify, and dual packages like hono

The mechanism split people reach for — `Module._load` patching for CJS
consumers, source transforms for ESM — is not actually needed: the tap
source-patches both module systems from one declarative entry, and
[`__test__/frameworks.spec.ts`](__test__/frameworks.spec.ts) proves it on
the real packages, one per shape:

- **express** (pure CJS, no ESM build): the entry targets `lib/express.js`
  and taps named `module.exports` properties (`json`, `Router`,
  `application`). Both consumer paths pass — `require('express')` and
  `import express from 'express'`, the CJS-over-ESM-loader corridor where
  `Module._load` patching was unreliable pre-fix. (The hook derives the
  format Node itself would assign — extension, then nearest package.json
  `"type"` — when `nextLoad` reports none, so a `.js` CJS file is never
  mis-parsed as ESM.)
- **fastify** (CJS whose `module.exports` IS the API function): wrapping the
  factory means rebinding the callable itself, which the reserved
  `"module.exports"` binding expresses — `bindings: ['module.exports']`,
  and the patch receives get/set accessors over the whole exports slot. One
  contract note: a package that self-references
  (`module.exports.fastify = fastify`, `.default`) needs its aliases
  rebound with it, ordinary monkey-patch duty.
- **hono** (true dual package: `dist/` ESM + `dist/cjs/` bundled CJS, both
  loadable in one process): one entry lists files from both trees and each
  is transformed in its own mode — the hook resolves the kind per tree via
  the nameless `{"type":"commonjs"}` package.json hono drops in `dist/cjs`.
  Two lessons generalize:
  - _Target the defining module, not the barrel._ `dist/index.js` only
    re-exports `Hono`; re-exports have no local binding to tap, so the ESM
    entry points at `dist/hono.js` where the class is declared.
  - _Mutation works everywhere; rebinding meets bundler reality._ Wrapping
    `Hono.prototype.route` (a get-only mutation) lands on both builds. But
    hono's `request`/`fetch` are class _fields_ — per-instance, invisible to
    prototype patching — so intercepting them means rebinding the export to
    a subclass. The ESM build's local binding allows that; the bundled CJS
    build defines exports as non-configurable getters **in sloppy mode**,
    where plain assignment is a silent no-op. The tap's CJS setter therefore
    verifies the rebind took and throws
    (`rebinding Hono had no effect (getter-only CJS export)`) — a loud
    failure at patch time instead of silently missing instrumentation. This
    is the one reach edge a loader facade (import-in-the-middle) keeps: its
    proxy can swap even getter-only exports, at the price of its mechanism.

The toy markers above prove mechanics; the _actual work_ such patches do is
captured in [`__test__/http-route.spec.ts`](__test__/http-route.spec.ts):
per-request **`http.route`** — the matched route _template_
(`/api/users/:id`, never `/users/42`), OTel's hardest-won HTTP semantic
attribute. Each patch in
[`patches/http-route.mjs`](__test__/fixtures/patch/patches/http-route.mjs)
mirrors the mechanism its opentelemetry-js-contrib counterpart uses,
delivered declaratively instead of via require-in-the-middle:

- **express** — observe at the app boundary (`application.handle`), wrap
  `res.end`, and read `req.baseUrl + req.route.path` at handler time, so
  mounted routers compose (`/api` + `/users/:id`).
- **fastify** — the wrapped factory adds an `onRequest` hook; routing has
  already resolved, so `request.routeOptions.url` is the template.
- **hono** — the subclass rebind auto-installs a middleware that reads
  `c.req.routePath` after `await next()` (the `@hono/otel` shape). ESM
  build only; on a require()d hono the capture is knowingly absent while
  the app keeps serving — degradation is open, never silent breakage.

#### Compared to orchestrion-js

Both tools express the same intent declaratively — a module matcher with a
semver range plus a description of what to instrument — but differ in what
the transform does and where user code runs.
[`__test__/orchestrion-compare.spec.ts`](__test__/orchestrion-compare.spec.ts)
runs orchestrion's `{ className: 'Client', methodName: 'send' }` function
query over the identical `@smithy/core` file and demonstrates the capability
split: orchestrion rewrites the method body into `tracingChannel` publishes —
subscribers _observe_ start/end/asyncEnd events but the return value is
untouchable — while the exports tap hands the class to user code that can
wrap, short-circuit, or rebind. `pnpm bench:patch` measures the transform on
that real file:

| transform (same `@smithy/core` client file)         |  latency |
| --------------------------------------------------- | -------: |
| oxc exports tap (`dist-es`, parse + validate)       |   ~10 µs |
| oxc exports tap (CJS snippet, nothing crosses napi) |  ~0.7 µs |
| orchestrion `Client#send` query (stock)             | ~1150 µs |
| orchestrion `Client#send` query (cached selector)   |  ~800 µs |

A profiling pass changed the tap's napi contract: originally the whole module
source round-tripped across the boundary just to append a few hundred bytes,
and the two O(n) UTF-16<->UTF-8 conversions dominated (the 42 KB CJS file
measured ~39 µs round-tripped vs ~0.7 µs snippet-only). Rust now returns just
the snippet and JS concatenates; the CJS path sends no source at all. What
remains of the ESM cost (~1 µs napi floor + ~9 µs) is the full-AST oxc parse
itself — the price of validation `lexEsm` doesn't attempt (const-ness, local
binding resolution, loud missing-export errors).

A second pass removed the string conversions that were left, exploiting that
`registerHooks`' `nextLoad` hands the hook the module source as UTF-8 bytes
and accepts bytes back. `exportsTapSnippetFromBuffer` (and
`transformLambdaFromBuffer` for the wrap) take that Buffer as-is: it crosses
napi zero-copy and oxc parses the UTF-8 in place, so the hook no longer pays
`source.toString()` nor the UTF-16 -> UTF-8 conversion of a napi string
argument — the patch-only runtime path now never materializes a UTF-16 copy
of a matched module (`applyMatched` accepts the Buffer and returns one, via
a single `Buffer.concat`). Two boundary lessons from measuring it: returning
the few-hundred-byte _snippet_ as a napi external Buffer costs a fixed ~3 µs
(more than the conversion it avoids — snippets stay strings), and the win on
the source side is proportional to module size: the complete hook operation
is a wash on the 1.8 KB `dist-es` file and a few percent ahead on a
42 KB module even before counting the string path's deferred rope flatten
and the retired UTF-16 allocation (`pnpm bench:patch` measures both paths,
small and large).

The ~100x gap is architectural, not incidental: the tap's oxc parse only
validates exports and appends, while orchestrion parses, queries and
regenerates the method body through its wasm/esquery pipeline — and unlike
the handler benchmark, memoizing `esquery.parse` no longer rescues it,
because the body rewrite itself dominates. The flip side is honest:
orchestrion's body injection can instrument _non-exported_ functions and
call-site interiors, which the exports tap by design cannot reach — its
reach is exactly what `Module._load` monkey-patching ever had.

#### Compared to import-in-the-middle

[import-in-the-middle](https://github.com/nodejs/import-in-the-middle) is the
third mechanism class — a loader proxy (the one OTel and dd-trace use for ESM
today): it wraps each matched module in a generated facade whose exports are
settable, and user callbacks patch the namespace at load time.
[`__test__/iitm-compare.spec.ts`](__test__/iitm-compare.spec.ts) pins down
the reach difference on the fixture package, in both iitm modes (classic
off-thread `module.register` and the synchronous `registerHooks` mode of
iitm 3.x, which needs Node >= 22.22.3 / 24.11.1 / 26):

| path into the module        | iitm (either mode) | exports tap |
| --------------------------- | ------------------ | ----------- |
| ESM `import`                | intercepted        | patched     |
| pure `require()` chain      | **never seen**     | patched     |
| build time (bundled output) | n/a                | patched     |

One number in the transform table needs its scope read carefully: iitm's
`lexEsm` (~5 µs) is only its _scan step_ — export names out of es-module-lexer,
nothing else — while the tap's ~10 µs is the _complete_ per-module operation:
full-AST parse, binding validation with local-name and const-ness resolution,
and the emitted accessors. iitm's remaining per-module work (facade source
generation, evaluating an extra module per interception, Hook callback
dispatch) happens inside Node's loader and resists isolated measurement — a
hand-rolled top-level scanner could match the lexer's scan speed natively,
but was rejected as the wrong trade: several hundred lines of
regex-heuristic lexing to shave microseconds off a once-per-matched-file
cost. The honest like-for-like comparison is whole processes — the
cold-start section of `pnpm bench:patch` on the fixture app (median of 9,
Node 24):

| setup                                   | cold start |    overhead |
| --------------------------------------- | ---------: | ----------: |
| baseline (no instrumentation)           |     ~34 ms |           — |
| exports tap, runtime hook (.mjs config) |     ~62 ms |      +28 ms |
| iitm sync (`registerHooks`)             |     ~55 ms |      +21 ms |
| exports tap, runtime hook (.ts config)  |    ~105 ms | +43 ms more |
| iitm off-thread (`module.register`)     |     ~96 ms |      +62 ms |

Mechanism to mechanism the tap and sync-mode iitm are peers (most of our
+7 ms delta is loading `semver` — trimmable), and both are ~3x cheaper than
the off-thread loader that ships as the OTel default. The `.ts` config row
is a convenience tax, not mechanism: Node's type-stripping toolchain
(amaro/SWC-wasm) costs ~40+ ms to initialize in the child — use a `.mjs`
config where cold start matters. What iitm cannot offer at any price: the
require() chain (the path the real AWS SDK takes under plain `node`) and a
build-time story — while its namespace-level patching does work without any
native addon, which remains its deployment advantage.

#### Serverless soundness: AWS Lambda and Azure Functions

The approach was historically blocked by broken Node module-loading
functionality (the issue trail in [Frida hooking (removed)](#frida-hooking-removed)),
so its soundness on the managed platforms is checked empirically, not
assumed. What [hooks/interplay-matrix](hooks/interplay-matrix) verifies
across the Node 22/24/26 ladder — including every pre-fix minor:

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
([`@wrap-esm-lambda/unplugin`](packages/unplugin)) delivers byte-identical
instrumentation with no runtime loader machinery at all — the hybrid design
is itself the mitigation for the next loader regression.

### WebAssembly

1. Run `rustup target add wasm32-wasip1-threads` to install build target
2. Run `pnpm build --target wasm32-wasip1-threads` to create `.wasm` file

### CI

CI tests against [`node@22`, `node@24`, `node@26`] x [`Linux`] matrix.

### Benchmarks

Two things are measured. The first is process **cold start**: how much each
hooking strategy adds to `node runtime.mjs`, timed with
[`hyperfine`](https://github.com/sharkdp/hyperfine). The table in
[releases](https://github.com/filipkunc/wrap-esm-lambda/releases) and the chart
below come from this.

To run it locally use:

```sh
sudo apt update && sudo apt install -y hyperfine
cd hooks && ./bench_hooks.sh
```

Example output is in [hooks/benchTable.md](hooks/benchTable.md):

![Cold start benchmark chart](hooks/benchChart.svg 'Cold start benchmark chart')

The second is raw **transform latency**: how long a single wrap costs each
library in-process, amortized over many calls (`pnpm bench` for the table,
`pnpm bench:chart` for the charts). The fastest and slowest approaches are
three orders of magnitude apart, so one linear axis squashes the fast group
into slivers and a log axis understates the gaps that matter. Instead there
are two linear charts with the exact value printed on each bar. The first
zooms into the approaches under 100 µs, where all the interesting differences
live:

```sh
pnpm bench:chart
```

![Transform latency chart, fast approaches](hooks/transformChart.svg 'Transform latency, approaches under 100 µs')

The second shows the whole field for scale:

![Transform latency chart, all approaches](hooks/transformChartAll.svg 'Transform latency, all approaches')

Notes on the transform-latency comparison:

- `regex` is a string replace with no parser, so it is fastest but only handles
  the shapes its pattern anticipates. `oxc.rs` is the fastest approach that
  actually parses to an AST.
- The `+ source map` bars emit a map that reaches the wrapped JS. oxc's native
  map costs only ~1 µs, so `oxc.rs + source map` is still faster than acorn with
  no map. `acorn + source map` (astring feeding a
  [`@jridgewell/source-map`](https://github.com/jridgewell/sourcemaps) generator)
  roughly doubles acorn's time — the map is nearly free when the codegen builds
  it in Rust, but a real per-node cost through a JS generator.
- The `+ map chained to .ts` bars go further: they transpile a TypeScript handler
  and compose the wrap map with tsc's map via `@ampproject/remapping` so the
  result reaches the original `.ts` (see [Source maps](#source-maps)). The
  compose is the same parser-independent step for both, so the gap between them
  (oxc ~27 µs vs acorn ~47 µs) is the parser/codegen difference, and oxc chained
  still lands near orchestrion's cached, no-map transform.
- `oxc.rs + map chained in Rust` produces the same chained map but composes it
  with `oxc_sourcemap` inside the addon instead of `remapping` in JS (see
  [Composing the maps in Rust](#composing-the-maps-in-rust-instead-of-remapping)).
  Skipping the JS compose and the wrap map's JSON round-trip across napi brings
  ~27 µs down to ~11 µs, faster than `acorn + source map` even though it also
  chains to the `.ts`.
- `orchestrion (cached selector)` memoizes orchestrion's per-call
  `esquery.parse`, which its shipped code recompiles on every `transform()`.
  That one change accounts for the ~10x gap to `orchestrion (minimal wrap)`.
- `orchestrion (tracing)` is orchestrion's stock output (a full
  `diagnostics_channel` wrapper), so it does more work than the minimal
  `wrapper(...)` the others emit.
- `swc.rs (wasm)` reflects the cost of calling the swc plugin across the wasm
  boundary, not swc's native transform speed.

### Frida hooking (removed)

Earlier versions carried a [Frida](https://frida.re/)-based fallback: `libc`
`open`/`read` and `uv_fs_fstat` detours (installed via `LD_PRELOAD` or an
`installHooks()` export) that rewrote `handler.mjs` at file-read time,
underneath the module system entirely. It existed as insurance for an era
when patching Node's module loading kept breaking under Node's own refactors:

- [nodejs/node#21573](https://github.com/nodejs/node/pull/21573) switched the
  CJS loader from `Module.wrap` to `vm.compileFunction`, silently bypassing
  tools that patched the wrapper (the nyc/istanbul-style breakage, still
  echoing years later in
  [nodejs/node#49653](https://github.com/nodejs/node/issues/49653));
- the Node 20.6 loader restructure
  ([nodejs/node#47999](https://github.com/nodejs/node/pull/47999)) moved
  `import`-ed CJS off the monkey-patchable `Module._load` path and shipped
  regressions like
  [nodejs/node#49497](https://github.com/nodejs/node/issues/49497);
- as recently as v24.15.0,
  [nodejs/node#62786](https://github.com/nodejs/node/issues/62786) broke
  `require.extensions`-reading tools (pirates, ts-node, Next's require hook)
  for CJS served through the ESM loader;
- even `registerHooks` itself and `Module._load` went through a broken-interplay
  phase across Node 22.16–22.18 and the 23.x/24.x lines: registering sync hooks
  rerouted CJS off `Module._load` entirely (blinding `Module._load` patchers —
  demonstrated by [dygabo/load_module_test](https://github.com/dygabo/load_module_test)),
  plain hooks died with `ERR_INVALID_RETURN_PROPERTY_VALUE`
  ([nodejs/node#59384](https://github.com/nodejs/node/issues/59384)), combining
  `register()` with `registerHooks()` fed CJS a null source
  ([nodejs/node#57327](https://github.com/nodejs/node/issues/57327)), and the
  umbrella issue
  [nodejs/node#59666](https://github.com/nodejs/node/issues/59666) catalogued
  double-invoked sync hooks and a re-invented `require` missing
  `require.cache`. The cluster was fixed by
  [nodejs/node#59929](https://github.com/nodejs/node/pull/59929) (shipped in
  v22.22.3 / v24.11.1 / v25.1.0 — the same fix train behind iitm's sync-mode
  version floor noted above) and
  [nodejs/node#60380](https://github.com/nodejs/node/pull/60380).
  [hooks/interplay-matrix](hooks/interplay-matrix) reproduces this phase
  empirically (`node hooks/interplay-matrix/run.mjs`): across a ladder of
  official Node 22/24/26 builds, the `Module._load` blinding for `import`-ed
  CJS flips off at exactly 22.22.3/24.11.1, the hook-fed synthetic `require`
  still lacks `require.extensions`/`require.cache` on all of 22.x, and this
  library's source-transform tap passes on every rung — including the broken
  window. That last row is the operative point for AWS Lambda, whose managed
  runtimes trail nodejs.org minors on AWS's own cadence and so can sit below
  the fix (check `process.version` in a live function): on such a runtime,
  `Module._load`-based instrumentation silently loses `import`-ed CJS the
  moment sync hooks register, while the tap's behavior is identical on both
  sides of the fix.

That instability is exactly what
[nodejs/node#52219](https://github.com/nodejs/node/issues/52219) set out to
end, and its outcome — synchronous `module.registerHooks()`
([tracking issue nodejs/node#56241](https://github.com/nodejs/node/issues/56241)) —
is a supported API that sees both `require()` and `import` in-thread. This
library's runtime shell is built on it, so the fs-level detours no longer buy
any coverage the hooks lack, while costing native-only builds, `unsafe`
transmutes, and a fragile `uv_fs_fstat` signature (`libuv_sys2::uv_fs_t` has
no stable layout). The approach was removed; it survives in git history for
the archaeology.
