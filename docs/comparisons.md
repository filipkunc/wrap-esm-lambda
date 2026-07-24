# Comparisons with other instrumentation mechanisms

The declarative exports tap (see the [main README](../README.md)) is one of
three mechanism classes for reaching a module's exports. This document pins
its reach and cost against the other two — orchestrion-js's body rewriting
and import-in-the-middle's loader proxy — with tests over the identical
targets.

## Compared to orchestrion-js

Both tools express the same intent declaratively — a module matcher with a
semver range plus a description of what to instrument — but differ in what
the transform does and where user code runs.
[`__test__/orchestrion-compare.spec.ts`](../__test__/orchestrion-compare.spec.ts)
runs orchestrion's `{ className: 'Client', methodName: 'send' }` function
query over the identical `@smithy/core` file and demonstrates the capability
split: orchestrion rewrites the method body into `tracingChannel` publishes —
subscribers _observe_ start/end/asyncEnd events but the return value is
untouchable — while the exports tap hands the class to user code that can
wrap, short-circuit, or rebind. `pnpm bench:patch` measures the transform on
that real file:

| transform (same `@smithy/core` client file)         |  latency |
| --------------------------------------------------- | -------: |
| oxc exports tap (`dist-es`, parse + validate)       |   ~14 µs |
| oxc exports tap (CJS snippet, nothing crosses napi) |  ~2.4 µs |
| orchestrion `Client#send` query (stock)             | ~1200 µs |
| orchestrion `Client#send` query (cached selector)   |  ~950 µs |

(The tap's napi contract now takes all of a module's patch entries as one
array-of-objects call — one parse for N entries and room for the rewrite
path's `code`/`map` results. That object plumbing costs a fixed couple of
microseconds over the old scalar per-entry call, which is why the CJS
snippet row reads ~2.4 µs; the per-module totals below absorb it.)

A profiling pass changed the tap's napi contract: originally the whole module
source round-tripped across the boundary just to append a few hundred bytes,
and the two O(n) UTF-16<->UTF-8 conversions dominated (the 42 KB CJS file
measured ~39 µs round-tripped vs ~0.7 µs snippet-only). Rust now returns just
the snippet and JS concatenates; the CJS path sends no source at all. What
remains of the ESM cost is dominated by the full-AST oxc parse
itself — the price of validation `lexEsm` doesn't attempt (const-ness, local
binding resolution, loud missing-export errors).

A second pass removed the string conversions that were left, exploiting that
`registerHooks`' `nextLoad` hands the hook the module source as UTF-8 bytes
and accepts bytes back. `exportsTapFromBuffer` (and
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
validates exports and appends (regenerating the module solely for export
shapes that need restructuring), while orchestrion parses, queries and
regenerates the method body through its wasm/esquery pipeline — and unlike
the handler benchmark, memoizing `esquery.parse` no longer rescues it,
because the body rewrite itself dominates. The flip side is honest:
orchestrion's body injection can instrument _non-exported_ functions and
call-site interiors, which the exports tap by design cannot reach — its
reach is exactly what `Module._load` monkey-patching ever had.

## Compared to import-in-the-middle

[import-in-the-middle](https://github.com/nodejs/import-in-the-middle) is the
third mechanism class — a loader proxy (the one OTel and dd-trace use for ESM
today): it wraps each matched module in a generated facade whose exports are
settable, and user callbacks patch the namespace at load time.
[`__test__/iitm-compare.spec.ts`](../__test__/iitm-compare.spec.ts) pins down
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
nothing else — while the tap's ~14 µs is the _complete_ per-module operation:
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

Mechanism to mechanism the tap and sync-mode iitm are peers, and both are
~3x cheaper than the off-thread loader that ships as the OTel default. (At
the time of that table most of the tap's +7 ms delta over iitm was loading
`semver`; core has since replaced it with an in-package range matcher —
differential-tested against `semver` in
[`__test__/range.spec.ts`](../__test__/range.spec.ts) — which cut the
.mjs-config hook's measured overhead roughly in half, from ~57 ms to
~29 ms on the container that re-measured it. Core now has no third-party
JS dependencies at all.) The `.ts` config row
is a convenience tax, not mechanism: Node's type-stripping toolchain
(amaro/SWC-wasm) costs ~40+ ms to initialize in the child — use a `.mjs`
config where cold start matters. What iitm cannot offer at any price: the
require() chain (the path the real AWS SDK takes under plain `node`) and a
build-time story — while its namespace-level patching does work without any
native addon, which remains its deployment advantage.

One reach edge favors the loader proxy: because its facade's exports are
settable, iitm can swap even getter-only exports of bundled CJS packages,
which the tap's verified setter refuses loudly instead (see the hono notes
in the main README's worked examples). That is the price and the power of each mechanism's
position in the pipeline.
