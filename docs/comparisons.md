# Comparisons with other instrumentation mechanisms

The declarative exports tap (see the [main README](../README.md)) is one of
three mechanism classes for reaching a module's exports. This document pins
its reach and cost against the other two — orchestrion-js's body rewriting
and import-in-the-middle's loader proxy — with tests over the identical
targets.

## Compared to orchestrion-js

Both tools start from declarative module matching, but expose different control
surfaces after a match. The exports tap hands exported bindings to ordinary
patch code. Orchestrion queries the module AST and rewrites the matched node.

| capability | exports tap | Orchestrion |
| --- | --- | --- |
| wrap or rebind an exported value | direct live-binding access | possible through a matching rewrite or custom transform |
| observe a function invocation | patch code chooses how | built-in `TracingChannel` transforms |
| change a returned value | patch code controls the wrapper | subscribers can replace `message.result` for supported return shapes |
| target private or nested code | not currently implemented | private-method queries and arbitrary `astQuery` selectors |
| define a non-tracing rewrite | patch code runs at module evaluation | registered custom AST transforms |
| runtime and build-time delivery | hooks and unplugin share one transform | tracing hooks and bundler plugins |

Neither mechanism is a strict superset of the other. Orchestrion reaches
non-exported implementation details today. The exports tap keeps the injected
transform generic and defers policy to normal JavaScript, which makes exported
objects easy to wrap, short-circuit or replace. The behavioral comparison in
[`tests/orchestrion-compare.spec.ts`](../tests/orchestrion-compare.spec.ts)
uses the same `Client#send` fixture and verifies that both mechanisms can
change `sent:hello` to `patched:sent:hello`.

### Performance comparison

The old table compared unlike operations: validating and tapping the exported
`Client` binding on one side, and locating plus rewriting the body of
`Client#send` on the other. Sharing a source file did not make those
operations equivalent, and the CJS snippet-only row did not parse that source
at all. Those numbers have been removed.

`pnpm bench:compare` is the narrower replacement. It:

- reads the same real `@smithy/core` ESM source for both tools;
- preselects one Wrap entry and one Orchestrion transformer, so setup is
  excluded on both sides;
- gives both transforms the same string input and the same intent: enable user
  code to change the result of `Client#send`;
- runs each tool in its own child process with identical Tinybench settings;
- fails unless each transform actually changes the source in the expected way;
- prints Node, platform, CPU and exact package versions beside p50, p95, p99,
  relative margin of error and sample count.

This is deliberately a **transform diagnostic**, not a whole-product verdict.
It excludes config loading, hook registration, module compilation, patch or
subscriber execution, and steady-state invocation cost. In particular, it
must not be combined with the snippet-only CJS diagnostic or described as an
architectural speedup.

Whole-process cold starts remain in
[`benchmarks/hooks`](../benchmarks/hooks). They are useful for measuring this
project against its own baseline. A cross-project cold-start headline requires
equivalent production adapters and verified behavior on both sides; the
current hand-written Orchestrion hook is not used for such a claim.

## Compared to import-in-the-middle

[import-in-the-middle](https://github.com/nodejs/import-in-the-middle) is the
third mechanism class — a loader proxy (the one OTel and dd-trace use for ESM
today): it wraps each matched module in a generated facade whose exports are
settable, and user callbacks patch the namespace at load time.
[`tests/iitm-compare.spec.ts`](../tests/iitm-compare.spec.ts) pins down
the reach difference on the fixture package, in both iitm modes (classic
off-thread `module.register` and the synchronous `registerHooks` mode of
iitm 3.x, which needs Node >= 22.22.3 / 24.11.1 / 26):

| path into the module        | iitm (either mode) | exports tap |
| --------------------------- | ------------------ | ----------- |
| ESM `import`                | intercepted        | patched     |
| pure `require()` chain      | **never seen**     | patched     |
| build time (bundled output) | n/a                | patched     |

One number in the transform table needs its scope read carefully: iitm's
Parser and scanner microbenchmarks are intentionally not compared here: an
`es-module-lexer` scan, a full AST transform, and evaluating a generated
facade perform different work. Since instrumentation normally transforms a
matched module once, the honest mechanism comparison is whole-process cold
start. [`benchmarks/hooks/bench_hooks.sh`](../benchmarks/hooks/bench_hooks.sh) uses Hyperfine for
that comparison, and CI interleaves base and head commands on the same runner;
see [benchmarks.md](benchmarks.md).

What iitm cannot offer at any price is the require() chain (the path the real
AWS SDK takes under plain `node`) or a build-time story. Its namespace-level
patching works without a native addon, which remains its deployment advantage.

One reach edge favors the loader proxy: because its facade's exports are
settable, iitm can swap even getter-only exports of bundled CJS packages,
which the tap's verified setter refuses loudly instead (see the hono notes
in the main README's worked examples). That is the price and the power of each mechanism's
position in the pipeline.
