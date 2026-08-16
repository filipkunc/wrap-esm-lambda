# Benchmarks

Cold start is the primary performance measure. A transformed module normally
runs through the hook once, so repeated in-process transforms are diagnostics,
not the user-visible headline.

## Cold start

[`benchmarks/hooks/bench_hooks.sh`](../benchmarks/hooks/bench_hooks.sh) uses
[`hyperfine`](https://github.com/sharkdp/hyperfine) to launch a fresh Node
process for every sample. It compares the baseline, a no-op synchronous hook,
the production runtime tap under OXC and Acorn, plus hand-written probes of
neighboring mechanisms. Every row is a complete process, but the adapters are
not equivalent products: the Wrap rows load its production registration and
config path, while the Orchestrion rows use a small benchmark-local hook.
Those neighboring rows are exploratory and are not a sound basis for a
cross-project headline.

```sh
sudo apt update && sudo apt install -y hyperfine
cd benchmarks/hooks && ./bench_hooks.sh
```

The committed result is [benchmarks/hooks/benchTable.md](../benchmarks/hooks/benchTable.md):

![Cold start benchmark chart](../benchmarks/hooks/benchChart.svg 'Cold start benchmark chart')

On pull requests, CI builds base and head side by side and interleaves their
commands in one Hyperfine invocation. This avoids comparing numbers from
different shared runners. The table is published in the workflow summary.

## Engine transform diagnostics

`pnpm bench` also runs a focused OXC-versus-Acorn diagnostic suite using
[Tinybench](https://github.com/tinylibs/tinybench). Every case calls core's
production `applyMatched()` entry point—the same function used by the runtime
hook and build plugins—with loader-style `Buffer` inputs. Each engine runs in
its own process and is verified after binding, preventing native fallback from
making both columns measure Acorn.

The cases cover:

- ESM append-only validation on the real `@smithy/core` client module;
- the complete CJS evaluation wrapper on its real compiled client;
- Hono's larger `Context` module on the append path;
- TypeScript lowering, binding rewrite, code generation, and upstream-map
  chaining.

Tinybench reports p50, p99, relative margin of error, and sample count. The
chart uses p50 bars and prints p99 beside them:

![The two engines in detail](../benchmarks/hooks/tapEngineChart.svg 'Production transform latency under OXC and Acorn')

```sh
pnpm bench        # transform distributions
pnpm bench:chart  # regenerate the engine chart
```

These measurements answer where engine time goes; they do not pretend that a
parser call equals a complete instrumentation mechanism. Low-level
`exportsTap()` or parser profiling belongs in temporary `perf`/flamegraph
investigations when a production case behaves unexpectedly.

## Same-fixture Wrap/Orchestrion transform diagnostic

`pnpm bench:compare` measures the overlapping Promise-result task described
in [the Orchestrion comparison](comparisons.md#performance-comparison). Both
tools receive the same string containing the real `@smithy/core` ESM client,
with a preselected matcher. Each tool runs under identical Tinybench settings
in its own child process.

This is the same fixture and overlapping outcome, not equal internal work.
Wrap's timed path validates the exported `Client` binding and appends a tap;
the method wrapper is supplied later by patch code during module evaluation.
Orchestrion's timed path locates and rewrites `send`, generating its generic
tracing lifecycle inside the transform. Module evaluation and patch/subscriber
execution are excluded for both.

The real `Client#send` also supports callback overloads. The Orchestrion
configuration uses `kind: "Async"`, so this diagnostic covers only the
Promise-return path whose resolved value both mechanisms can replace. It also
measures warmed-up transform throughput: the untimed verification call and
Tinybench warmup exclude first-transform initialization.

The command prints the exact package versions, Node version, platform, CPU,
p50, p95, p99, relative margin of error and sample count. Its launch order is
randomized to avoid always favoring the first process. In CI the same sample
set produces a table in the job summary plus an SVG chart, Markdown table and
raw JSON in the `bench-charts` artifact:

```sh
pnpm bench:compare
```

The behavioral test executes a smaller transformed fixture and proves that
both mechanisms change the same Promise result. Against the real Smithy source,
the worker rejects unchanged output or missing mechanism-specific markers
before collecting samples; it does not claim to execute that full client.

These numbers cover hot transform time only. They exclude matcher construction,
config loading, hook registration, first-transform initialization, module
compilation and evaluation, patch or subscriber execution, and invocation
overhead. Publish them only with this scope and the emitted environment
metadata; do not turn their ratio into a whole-product or equal-work claim.

## Real npm packages

The wider engine comparison is [`tests/corpus/bench.mts`](../tests/corpus/bench.mts). It
runs `applyMatched()` over the statically visible export surfaces of the pinned
npm corpus, including star graphs and filesystem reads. The companion
behavioral corpus executes the transformed packages under both engines, so a
fast result cannot hide broken output. See the [corpus README](../tests/corpus/README.md).

Transform diagnostics intentionally exclude config loading, package matching,
Node compilation, and patch execution. Hyperfine cold starts include those
costs and remain the regression metric for this project's production path.
Cross-project cold-start claims additionally require equivalent production
adapters and verified behavior.
