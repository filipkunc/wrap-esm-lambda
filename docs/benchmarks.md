# Benchmarks

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

Example output is in [hooks/benchTable.md](../hooks/benchTable.md):

![Cold start benchmark chart](../hooks/benchChart.svg 'Cold start benchmark chart')

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

![Transform latency chart, fast approaches](../hooks/transformChart.svg 'Transform latency, approaches under 100 µs')

The second shows the whole field for scale:

![Transform latency chart, all approaches](../hooks/transformChartAll.svg 'Transform latency, all approaches')

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
  and compose the wrap map with tsc's map via `@jridgewell/remapping` so the
  result reaches the original `.ts` (see [source-maps.md](source-maps.md)). The
  compose is the same parser-independent step for both, so the gap between them
  (oxc ~27 µs vs acorn ~47 µs) is the parser/codegen difference, and oxc chained
  still lands near orchestrion's cached, no-map transform.
- `oxc.rs + map chained in Rust` produces the same chained map but composes it
  with `oxc_sourcemap` inside the addon instead of `remapping` in JS (see
  [Composing the maps in Rust](source-maps.md#composing-the-maps-in-rust-instead-of-remapping)).
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

The patch-transform and cold-start comparisons against orchestrion-js and
import-in-the-middle (`pnpm bench:patch`) are discussed with their context in
[comparisons.md](comparisons.md).

## JS-only vs JS + Rust: the two engines

Every transform in core runs through one of two interchangeable engines
(selected by `WRAP_ESM_LAMBDA_ENGINE`, see the
[core README](../packages/core/README.md#choosing-the-engine)): the native
`wrap-esm-lambda` oxc addon, and the pure-JS
[`@wrap-esm-lambda/engine-acorn`](../packages/engine-acorn) built on acorn +
magic-string. They emit byte-identical snippets and pass the identical test
suite, so the numbers below isolate exactly one variable — whether the parse
and rewrite run in Rust across napi or in JavaScript in-process.

`pnpm bench:patch` measures the tap on the real `@smithy/core` client file
(1.8 KB dist-es; the "big module" rows pad it to the 42 KB of the dist-cjs
bundle), `pnpm bench` the handler wrap. Representative numbers (Node 22,
x86_64 Linux):

| operation                                            | oxc (JS + Rust) | acorn (JS only) |
| ---------------------------------------------------- | --------------: | --------------: |
| exports tap, ESM parse + validate (1.8 KB)           |          ~14 µs |          ~86 µs |
| whole hook op on a 42 KB module                      |          ~41 µs |          ~91 µs |
| exports tap, CJS snippet (no parse)                  |         ~2.9 µs |         ~0.4 µs |
| handler wrap                                         |         ~3.5 µs |          ~14 µs |
| handler wrap + source map                            |         ~5.3 µs |          ~26 µs |
| runtime-hook cold start (fixture app, `.mjs` config) |          ~72 ms |          ~86 ms |

What the numbers say:

- **Parsing dominates, and Rust parses ~6x faster.** The tap's per-module
  cost is almost entirely the full-AST parse; oxc's arena parser beats
  acorn's by roughly 6x on the same file, and that ratio holds as modules
  grow (the napi boundary is amortized — buffers cross zero-copy).
- **When nothing is parsed, JS wins.** The CJS tap is pure string building;
  the acorn engine does it in-process for ~0.4 µs while the native call pays
  ~2.5 µs of napi overhead just to reach Rust. Boundary costs are real in
  both directions.
- **Cold start favors the native addon, mildly.** The JS engine swaps the
  addon's dlopen for the acorn + magic-string + remapping module graph,
  which reads as ~14 ms more on the fixture app. Both sit well under the
  off-thread loader baseline in [comparisons.md](comparisons.md).
- **Absolute numbers stay small either way.** Even the JS-only tap is ~11x
  cheaper than orchestrion's body-rewriting transform on the same file
  (~86 µs vs ~950–1200 µs), because the architecture — validate + append,
  rewrite only when a shape demands it — matters more than the parser.

The engines differ in _how_ they rewrite, deliberately: oxc regenerates the
module through codegen, while the acorn engine makes surgical magic-string
edits (demote one keyword, replace one statement, append), so untouched
lines keep their exact source text. On conventionally formatted sources even
the rewrite output converges byte-for-byte — pinned, along with snippet
byte-identity and error-message parity, by
[`__test__/engine-parity.spec.ts`](../__test__/engine-parity.spec.ts).
