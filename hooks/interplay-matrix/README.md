# registerHooks / `Module._load` interplay matrix

Empirically pins down the broken-interplay phase between synchronous
`module.registerHooks()` and `Module._load` monkey-patching (the
[dygabo/load_module_test](https://github.com/dygabo/load_module_test)
observation, [nodejs/node#59666](https://github.com/nodejs/node/issues/59666)
umbrella) across a ladder of official Node builds straddling the
[nodejs/node#59929](https://github.com/nodejs/node/pull/59929) fix train
(v22.22.3 / v24.11.1 / v25.1.0):

```sh
node hooks/interplay-matrix/run.mjs              # full ladder (linux x64)
node hooks/interplay-matrix/run.mjs 22.22.2      # explicit versions
```

Each scenario is a self-contained script printing one `RESULT:` token; the
runner downloads each Node build (cached in the OS tmpdir), runs every
scenario plus this repo's real runtime hook, and writes [matrix.md](matrix.md):

| version | builtin-eager-patch | cjs-append-hook | import-builtin-module-load | import-cjs-module-load-sync-hooks | import-cjs-module-load | import-cjs-synthetic-require | mixed-register-hooks | module-load-plain | module-load-sync-hooks | require-builtin-module-load-sync-hooks | require-module-load-override-hook | wrap-esm-lambda-tap-esm | wrap-esm-lambda-tap-cjs | tap-node-options-esm | tap-bootstrap-esm | tap-bootstrap-cjs |
| ------- | ------------------- | --------------- | -------------------------- | --------------------------------- | ---------------------- | ---------------------------- | -------------------- | ----------------- | ---------------------- | -------------------------------------- | --------------------------------- | ----------------------- | ----------------------- | -------------------- | ----------------- | ----------------- |
| 22.15.0 | PATCHED_ALL         | APPENDED        | BYPASSED                   | BYPASSED                          | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 22.16.0 | PATCHED_ALL         | APPENDED        | BYPASSED                   | BYPASSED                          | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 22.18.0 | PATCHED_ALL         | APPENDED        | BYPASSED                   | BYPASSED                          | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 22.22.2 | PATCHED_ALL         | APPENDED        | BYPASSED                   | BYPASSED                          | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 22.22.3 | PATCHED_ALL         | APPENDED        | BYPASSED                   | SEEN                              | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 22.23.1 | PATCHED_ALL         | APPENDED        | BYPASSED                   | SEEN                              | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 24.10.0 | PATCHED_ALL         | APPENDED        | BYPASSED                   | BYPASSED                          | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 24.11.0 | PATCHED_ALL         | APPENDED        | BYPASSED                   | BYPASSED                          | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 24.11.1 | PATCHED_ALL         | APPENDED        | BYPASSED                   | SEEN                              | SEEN                   | BARE_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 24.18.0 | PATCHED_ALL         | APPENDED        | BYPASSED                   | SEEN                              | SEEN                   | FULL_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |
| 26.5.0  | PATCHED_ALL         | APPENDED        | BYPASSED                   | SEEN                              | SEEN                   | FULL_REQUIRE                 | OK                   | SEEN              | SEEN                   | SEEN                                   | SEEN                              | OK                      | OK                      | OK                   | OK                | OK                |

## What the columns show

- **The blinding, pinned to the fix boundary.**
  `import-cjs-module-load-sync-hooks` patches `Module._load`, registers a
  _pure passthrough_ sync load hook, then `import`s a CJS module. On every
  pre-fix minor (22.15.0–22.22.2, 24.10.0–24.11.0) the patch never fires —
  registering any sync load hook rerouted `import`-ed CJS off `Module._load`
  entirely. The flip to SEEN lands exactly at 22.22.3 and 24.11.1, the
  [#59929](https://github.com/nodejs/node/pull/59929) releases. The baseline
  column (`import-cjs-module-load`, no hooks) is SEEN everywhere, proving the
  hook's mere presence caused the blinding. In practice: on a pre-fix minor,
  the moment anything registers a sync hook, every classic
  `Module._load`-patching APM goes silently blind for `import`-ed CJS — the
  path the AWS SDK takes in ESM apps.

- **The re-invented require.** `import-cjs-synthetic-require` `import`s a CJS
  module whose source a hook overrode, and checks the `require` it received:
  `BARE_REQUIRE` means neither `require.extensions` nor `require.cache`
  existed ([nodejs/node#59666](https://github.com/nodejs/node/issues/59666)'s
  "re-invented require", the class behind
  [nodejs/node#62786](https://github.com/nodejs/node/issues/62786)). Fixed in
  current 24.x/26.x — but still BARE on the entire 22.x line including
  22.23.1, so pirates/ts-node-style tools reading `require.extensions` at
  module top level still break there under a source-transforming hook.

- **The require() path never wavered.** `module-load-sync-hooks` and
  `require-module-load-override-hook` stay SEEN on every rung: plain
  `require()` kept flowing through `Module._load` with sync hooks present,
  passthrough or overriding. The interplay bug was specifically the ESM->CJS
  corridor.

- **The source-transform tap is immune.** The two `wrap-esm-lambda-tap-*`
  columns run this repo's actual runtime hook (native addon + registerHooks
  shell) on the patch fixture app — OK on every rung, pre-fix and post-fix,
  because the tap instruments module _source_ and never depended on
  `Module._load` staying patchable. (One napi build serves the whole ladder —
  node-api ABI stability.)

- **The built-in crux, measured.** Source transforms cannot reach `node:http`
  — built-ins have no source — so builtin patching classically leaned on
  `Module._load`. Three columns pin down what that dependence is actually
  worth: `require-builtin-module-load-sync-hooks` is SEEN on every rung
  (require-side builtin interception survived even the broken window);
  `import-builtin-module-load` is BYPASSED on every rung (`import` of a
  builtin has _never_ flowed through `Module._load` on any version — the
  patch point was never sufficient for ESM consumers, by design, not by
  bug); and `builtin-eager-patch` is PATCHED*ALL on every rung — patching
  the builtin's exports object at preload, before any user code, is
  observed by `require()`, ESM default import \_and* ESM named import alike,
  with no loader dependence at all. That last column is the mechanism the
  runtime shell uses for builtin patch entries.

- **The serverless delivery shape holds too.** On managed runtimes the node
  CLI is not yours: AWS Lambda injects flags through the `NODE_OPTIONS` env
  var and the process main is its CJS runtime interface client; Azure
  Functions's node worker is likewise a CJS bundle (flags via the
  `languageWorkers__node__arguments` app setting), and both load the user's
  handler late — dynamic `import()` for ESM, `require()` for CJS. The
  `tap-node-options-esm` column registers the hook purely via `NODE_OPTIONS`,
  and `tap-bootstrap-esm`/`tap-bootstrap-cjs` add
  [`fixtures/bootstrap-sim.cjs`](fixtures/bootstrap-sim.cjs) as the CJS main
  that loads the handler afterwards. OK on every rung — hook registration
  survives env-var delivery and platform-style late loading on both sides of
  the fix train.

## Why this matters for AWS Lambda

Lambda's managed runtimes apply Node minor updates on AWS's own cadence,
typically behind nodejs.org releases; v22.22.3 shipped 2026-05-13, so
`nodejs22.x` deployments can plausibly sit on a pre-fix minor (verify with
`process.version` in a live function — the base image CDNs don't expose the
embedded minor). On any pre-fix minor the left half of this table is the
operative reality: `Module._load`-based instrumentation silently loses
`import`-ed CJS coverage the moment sync hooks are registered, while the
source-transform approach keeps identical behavior on every rung, broken
window included.

The scenarios not shown flat here (`cjs-append-hook`, `mixed-register-hooks`,
`module-load-plain`) are deliberate controls: they demonstrate the simple
shapes that never broke, so the matrix distinguishes "the API was unusable"
(false) from "the API and the legacy patch point silently miscomposed" (true,
until the fix train).
