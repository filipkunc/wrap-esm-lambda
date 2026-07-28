# Benchmarks

Two things are measured, both against the toolkit's real subject — the
generic exports tap.

The first is process **cold start**: what each hooking mechanism adds to
`node runtime.mjs`, timed with
[`hyperfine`](https://github.com/sharkdp/hyperfine). The command set is the
tap's runtime shell on both engines (a path-matched entry wrapping the
fixture handler, activated exactly like production: `--import` + config),
bracketed by a no-op `registerHooks` floor and orchestrion's
`registerHooks` transforms on the same file:

```sh
sudo apt update && sudo apt install -y hyperfine
cd hooks && ./bench_hooks.sh
```

Example output is in [hooks/benchTable.md](../hooks/benchTable.md):

![Cold start benchmark chart](../hooks/benchChart.svg 'Cold start benchmark chart')

The second is raw **transform latency**: what instrumenting one module costs
in-process, amortized over many calls — `pnpm bench` for the table,
`pnpm bench:chart` for the charts. The input is not a toy: it is
`@smithy/core`'s client submodule, the file every `@aws-sdk/client-*`
`send()` funnels through, both as the 1.8 KB `dist-es` file and padded to
the 42 KB of the real `dist-cjs` bundle. The fastest and slowest approaches
are ~2 orders of magnitude apart, so one linear axis squashes the fast
group into slivers and a log axis understates the gaps that matter; instead
there are two linear charts with the exact value printed on each bar. The
first zooms into the approaches under 150 µs, where all the interesting
differences live:

![Transform latency chart, fast approaches](../hooks/transformChart.svg 'Exports tap latency, approaches under 150 µs')

The second shows the whole field for scale:

![Transform latency chart, all approaches](../hooks/transformChartAll.svg 'Exports tap latency, all approaches')

Notes on the comparison (cases in
[benchmark/tap-cases.ts](../benchmark/tap-cases.ts)):

- The `oxc exports tap` bars are a **complete** per-module operation: full
  AST parse plus validation of every requested binding against the module's
  statically visible exports. The `hook op` bars add the string/buffer
  plumbing a real `registerHooks` load hook pays; the buffer variants keep
  the source in UTF-8 across napi (zero-copy in, `Buffer.concat` out).
- The `acorn` bars are the same tap through the pure-JS engine — the
  JS-only vs JS + Rust comparison below.
- `iitm lexEsm` is import-in-the-middle's per-module analysis step
  (es-module-lexer) — the fair mechanism comparison for our
  parse + validate. Its full per-module cost additionally includes
  generating and evaluating a facade module per interception.
- The `orchestrion` bars are the same declarative intent (`Client#send`, as
  a `{ className, methodName }` function query) through orchestrion-js's
  body-rewriting transform; `cached selector` memoizes the `esquery.parse`
  its shipped code recompiles on every call.

The reach-vs-cost discussion around these numbers — what each mechanism can
and cannot intercept on identical targets — is in
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
Representative numbers (Node 22, x86_64 Linux, `pnpm bench`):

| operation                                            | oxc (JS + Rust) | acorn (JS only) |
| ---------------------------------------------------- | --------------: | --------------: |
| exports tap, ESM parse + validate (1.8 KB)           |          ~14 µs |          ~86 µs |
| whole hook op on a 42 KB module                      |          ~41 µs |          ~91 µs |
| exports tap, CJS snippet (no parse)                  |         ~2.9 µs |         ~0.4 µs |
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
