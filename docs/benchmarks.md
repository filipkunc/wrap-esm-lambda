# Benchmarks

Cold start is the primary performance measure. A transformed module normally
runs through the hook once, so repeated in-process transforms are diagnostics,
not the user-visible headline.

## Cold start

[`hooks/bench_hooks.sh`](../hooks/bench_hooks.sh) uses
[`hyperfine`](https://github.com/sharkdp/hyperfine) to launch a fresh Node
process for every sample. It compares the baseline, a no-op synchronous hook,
the runtime tap under OXC and Acorn, and neighboring instrumentation
mechanisms. Each command performs its real initialization and transformation
work; unlike parser microbenchmarks, the rows are comparable as complete
processes.

```sh
sudo apt update && sudo apt install -y hyperfine
cd hooks && ./bench_hooks.sh
```

The committed result is [hooks/benchTable.md](../hooks/benchTable.md):

![Cold start benchmark chart](../hooks/benchChart.svg 'Cold start benchmark chart')

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

![The two engines in detail](../hooks/tapEngineChart.svg 'Production transform latency under OXC and Acorn')

```sh
pnpm bench        # transform distributions
pnpm bench:chart  # regenerate the engine chart
```

These measurements answer where engine time goes; they do not pretend that a
parser call equals a complete instrumentation mechanism. Low-level
`exportsTap()` or parser profiling belongs in temporary `perf`/flamegraph
investigations when a production case behaves unexpectedly.

## Real npm packages

The wider engine comparison is [`corpus/bench.mts`](../corpus/bench.mts). It
runs `applyMatched()` over the statically visible export surfaces of the pinned
npm corpus, including star graphs and filesystem reads. The companion
behavioral corpus executes the transformed packages under both engines, so a
fast result cannot hide broken output. See the [corpus README](../corpus/README.md).

Transform diagnostics intentionally exclude config loading, package matching,
Node compilation, and patch execution. Hyperfine cold starts include those
costs and remain the metric to use for user-facing performance claims.
