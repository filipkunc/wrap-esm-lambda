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
the 42 KB of the real `dist-cjs` bundle. Two charts, split by what they
compare — not by speed — with the exact value printed on each bar.

The first is the **mechanism comparison**, apples to apples: one bar per
tool, each doing its per-module analysis/transform of the same 1.8 KB
file. The ~100x spread is the story, so the axis stays linear:

![Per-module transform cost, one bar per tool](../hooks/tapMechanismChart.svg 'Per-module transform cost — one bar per tool, same 1.8 KB module')

The second is **this package's two engines in detail** — the tiers,
string-vs-buffer plumbing and input sizes that only make sense compared
within oxc/acorn:

![The two engines in detail](../hooks/tapEngineChart.svg 'The two engines in detail — tiers, plumbing, input sizes')

Every bar label reads **`tool: operation (input size)`** (cases in
[benchmark/tap-cases.ts](../benchmark/tap-cases.ts)). The tools are `oxc`
and `acorn` — this package's two engines — plus the neighbors, `iitm`
(import-in-the-middle) and `orchestrion`. The operations come in two tiers:

- **`tap:`** — the transform call alone: full AST parse plus validation of
  every requested binding against the module's statically visible exports
  (the CJS row skips the parse entirely — CJS taps are pure snippet
  emission).
- **`whole hook op:`** — everything a real `registerHooks` load hook does
  per module: take `nextLoad`'s bytes, transform, append the snippet.
  `decode + tap + append` is the string plumbing (Buffer → UTF-16 →
  napi); `zero-copy buffer` keeps the source in UTF-8 end to end
  (`exportsTapFromBuffer` + `Buffer.concat`) — the path the runtime shell
  actually ships. The acorn engine has no zero-copy variant: it parses
  in-process, so there is no napi boundary for a buffer to save.

The neighbors, for mechanism-fair comparison: `iitm: lexEsm analysis step`
is import-in-the-middle's per-module scan (es-module-lexer) — its full cost
additionally includes generating and evaluating a facade module per
interception. The `orchestrion:` bars are the same declarative intent
(`Client#send`, as a `{ className, methodName }` function query) through
orchestrion-js's body-rewriting transform; `cached selector` memoizes the
`esquery.parse` its shipped code recompiles on every call.

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
