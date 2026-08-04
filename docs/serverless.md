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
- **Bootstrap ordering**: both platforms boot their own main first and load
  the user handler late — but not through the same loader, which is the part
  that matters here. Lambda's runtime interface client is an **ES module**
  (`"main": "dist/index.mjs"`, `"bin": {"aws-lambda-ric": "bin/index.mjs"}`;
  the managed runtime boots `/var/runtime/index.mjs`), so the process main
  enters through the ESM loader and reaches CJS via `createRequire`. Azure's
  node worker is still a CJS bundle. Either way the handler arrives late and
  indirectly, by the rule the RIC's `UserFunction.js` applies — extension
  first, `.js` decided by the nearest package.json `"type"`:
  `(pjHasModule && await _tryAwaitImport(p, '.js')) || (await _tryAwaitImport(p, '.mjs')) || _tryRequireFile(p, '.cjs')`.
  The matrix runs both mains against both handler module systems — the
  `tap-esm-main-*` (Lambda) and `tap-cjs-main-*` (Azure) columns — OK on
  every rung, both sides of the fix train.
- **The broken window itself**: the tap never touches `Module._load`, so the
  22.15.0–22.22.2 / 24.10.0–24.11.0 interplay bugs that blinded
  patch-based instrumentation don't reach it.

Platform version reality (mid-2026): Lambda offers `nodejs22.x` and
`nodejs24.x` ([runtimes table](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html));
Azure Functions host 4.x publishes Node 20, 22 and 24 images (Node 22 runs
to April 2027; Node 22 is the last major for Linux Consumption, Node 24
wants Flex Consumption — [supported languages](https://learn.microsoft.com/en-us/azure/azure-functions/supported-languages)).
Both vendors apply Node _minor_ updates on their own cadence behind
nodejs.org and neither announces the embedded minor, but for the **container
images** it is not actually a mystery: it is readable straight out of the
published image, and as of 2026-07-26 both vendors sit on the same two
minors, both comfortably past the v22.22.3 / v24.11.1 fix train.

| image                             | Node     |
| --------------------------------- | -------- |
| `public.ecr.aws/lambda/nodejs:22` | v22.23.1 |
| `public.ecr.aws/lambda/nodejs:24` | v24.18.0 |
| `azure-functions/node:4-node22`   | v22.23.1 |
| `azure-functions/node:4-node24`   | v24.18.0 |
| `azure-functions/node:4-node20`   | v20.20.2 |

(Node 20 is moot here regardless: `module.registerHooks` arrives in 22.15.0,
and this package's `engines` floor is Node 22.)

What stays unanswerable is the **non-container** path — the zip-deployed
managed runtimes, where nothing publishes the minor and only
`process.version` from a live function can tell you. So the fix-train
question is settled for anyone on images and still open for everyone else,
which is why the matrix exists: the tap behaves identically on both sides,
and the answer does not have to matter.

For Lambda specifically, CI stops simulating and uses the platform's own
image. A lane runs the whole suite — both engines, the prebuilt addon
loaded off Amazon Linux 2023's glibc — inside
`public.ecr.aws/lambda/nodejs:22` and `:24`, on x86_64 and Graviton, and
then reruns the delivery shape above on that image: `NODE_OPTIONS`
registration with the RIC bootstrap stand-in as the process main. Two more
steps then drop the stand-in and answer real invocations through the
image's own runtime interface client — one with a package-identity config,
one with a config that names nothing at all: the `aws-lambda` preset
(`@wrap-esm-lambda/hooks/aws-lambda`) derives the handler's file and export
from `_HANDLER`/`LAMBDA_TASK_ROOT` at preload, the same contract the RIC
itself reads, so the function's own handler is instrumented by the generic
exports tap with zero handler-specific configuration — the ESM
`export const` shape through the tap's rewrite path, the CJS
`exports.handler` shape as a `module.exports` property tap. That does
not settle the managed-runtime minor question — the zip runtime is not the
container image — but it removes the container path from the guesswork
entirely, and each run records the image's `node --version` and manifest
digest on the job summary, so the minor AWS is shipping is on the record
without anyone reading two thousand lines of TAP output to find it.

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

## Azure Functions: the hook pipeline, first and last

For Azure the delivery question above is only half the story, because the
platform ships something Lambda does not: an extension pipeline of its own.
What the worker actually does (v4 programming model;
`Azure/azure-functions-nodejs-worker`, mirrored line-for-line by
[`__test__/azure-functions.spec.ts`](../__test__/azure-functions.spec.ts)):

- **Hooks execute strictly in registration order** — a plain array, pushed by
  `registerHook`, iterated as a sequential awaited loop. There is no priority
  API; disposal splices; re-registering pushes to the tail. Array position is
  the entire ordering contract.
- **Pre hooks own the invocation's shape**: the worker reads `inputs` and
  `functionCallback` back off the pre-hook context after the chain runs, so
  any pre hook may wrap — or replace — the handler. **Post hooks own the
  outcome**: `result` and `error` are read back the same way, so a post hook
  can mutate the response or suppress the error.
- **The registry is not a file.** `@azure/functions-core` is served from a
  `Module.prototype.require` proxy the worker installs at setup. Before that
  instant the specifier resolves nowhere — which has two consequences. A
  `--require`/`--import` preload cannot register hooks (this is why agents
  register from app code on Azure), and a copy of `@azure/functions` loaded
  at preload is permanently broken: its `tryGetCoreApiLazy` caches the miss
  forever and every later `app.hook.*`/`app.http()` call becomes a
  console.warn no-op. Do not import the library from a config.

The `azure-functions` preset (`@wrap-esm-lambda/hooks/azure-functions`) turns
those mechanics into a bracket. "First" is won by timing: nobody can register
before worker setup, and a load event fires before its module's body runs, so
activating at the first post-setup load event beats the first line of user
code. "Last" cannot be won by timing — anyone may register later — so the
preset patches `registerHook` in place on the shared object the require proxy
hands out: the one choke point every registration path funnels through, the
`app.hook.*` of every library copy and Application Insights' direct core
usage alike. Each foreign registration is attributed (nearest stack frame
outside the preset and the library, mapped to its `node_modules` package),
its pre/post callbacks are wrapped for per-invocation timing, and the
preset's closing hooks are disposed and re-pushed so the tail keeps holding —
against late registrations too, including mid-invocation ones. That property
assignment is this repo's one deliberate step outside file transforms, and it
is the same move the aws-lambda preset makes with `_HANDLER`: reading the
platform's own extension contract (the module loader is never touched). The
honest limit: an agent that captured a reference to `registerHook` _before_
activation and calls it later would bypass the choke point — on Azure that
window is worker boot only, where no third-party code runs.

Each invocation reports the full nesting: `totalMs` (first pre hook → last
post hook), `callbackMs` (outermost callback wrapper — applied by the
preset's _last_ pre hook, so it contains every foreign wrapper), `handlerMs`
(innermost — applied by its _first_ pre hook, nothing between it and user
code), per-hook timings for every foreign hook, and flags for anything that
swapped the inputs, replaced the callback, bypassed the handler, or mutated
the result or error on the way out.

Delivery, then, has two shapes. The worker-arguments preload
(`languageWorkers__node__arguments = --import @wrap-esm-lambda/hooks/register`,
the config arming the preset) is the Lambda-like route and additionally
covers file taps on modules the worker itself loads — but Azure documents
that custom worker arguments forfeit prewarmed workers, a real cold-start
cost. The `package.json` `"main"` prelude (call `activateAzureFunctions()`
first thing) is the platform's own recommendation for agents, keeps prewarm,
and loses nothing hook-wise — the worker is set up before any user module
loads, and being first in `"main"` is being first among user code. The only
thing the prelude cannot do is out-run _another preloaded agent's_ file taps.
[examples/azure-functions](../examples/azure-functions) runs both shapes
under Core Tools' `func start` — the real host spawning the real worker, so
the pipeline is the production one, not an emulation of it — against a fake
coexisting agent that registers through both funnels and once mid-invocation;
the CI Azure lane (`test-azure-functions`) asserts the ordering, the timings
and the attribution on Node 22 and 24.
