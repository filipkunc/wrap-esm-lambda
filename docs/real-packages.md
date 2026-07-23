# Patching real packages: express, fastify, hono, the AWS SDK and builtins

Field notes from pointing the declarative exports tap at real packages — one
per module-system shape. Each section is backed by a spec that runs the real
package.

## The AWS SDK (`@smithy/core`)

[`__test__/aws.spec.ts`](../__test__/aws.spec.ts) proves the tap against the
real AWS SDK: every `@aws-sdk/client-*` operation funnels through
`Client#send` in `@smithy/core`'s client submodule, so a single entry
intercepts `S3Client`'s `PutObjectCommand` — through the runtime hook on the
SDK's bundled `dist-cjs` and through esbuild on its `dist-es`, same patch
code. [`__test__/patch.spec.ts`](../__test__/patch.spec.ts) covers the
mechanics on a fixture package (emission shapes, loud failures, version-range
gating, CJS getter-only exports, the double-patch guard).

## Frameworks, one per shape

The mechanism split people reach for — `Module._load` patching for CJS
consumers, source transforms for ESM — is not actually needed: the tap
source-patches both module systems from one declarative entry, and
[`__test__/frameworks.spec.ts`](../__test__/frameworks.spec.ts) proves it on
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
  - _Prefer the defining module over the barrel._ `dist/index.js` only
    re-exports `Hono`, and a re-export has no local binding — tapping it
    makes the transform restructure the barrel (splitting the specifier
    into an import plus a rebindable local, with the snapshot semantics
    documented in the
    [patch author contract](../packages/core/README.md#patch-author-contract)).
    Pointing the entry at `dist/hono.js`, where the class is declared,
    keeps the tap on its append-only fast path and patches the class for
    every import route — including consumers that bypass the barrel.
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
    proxy can swap even getter-only exports, at the price of its mechanism
    (see [comparisons.md](comparisons.md)).

## The actual work: `http.route`

The toy markers above prove mechanics; the _actual work_ such patches do is
captured in [`__test__/http-route.spec.ts`](../__test__/http-route.spec.ts):
per-request **`http.route`** — the matched route _template_
(`/api/users/:id`, never `/users/42`), OTel's hardest-won HTTP semantic
attribute. Each patch in
[`patches/http-route.mjs`](../__test__/fixtures/patch/patches/http-route.mjs)
mirrors the mechanism its opentelemetry-js-contrib counterpart uses,
delivered declaratively instead of via require-in-the-middle:

- **express** — observe at the app boundary (`application.handle`), wrap
  `res.end`, and read `req.baseUrl + req.route.path` at handler time, so
  mounted routers compose (`/api` + `/users/:id`). This one is also a
  runnable example: [examples/express-route](../examples/express-route).
- **fastify** — the wrapped factory adds an `onRequest` hook; routing has
  already resolved, so `request.routeOptions.url` is the template.
- **hono** — the subclass rebind auto-installs a middleware that reads
  `c.req.routePath` after `await next()` (the `@hono/otel` shape). ESM
  build only; on a require()d hono the capture is knowingly absent while
  the app keeps serving — degradation is open, never silent breakage.

## Built-ins: `node:http` and friends

Source transforms cannot reach built-ins — `node:http` has no source for a
load hook or bundler to rewrite — and the classic answer was `Module._load`
interception. The [interplay matrix](../hooks/interplay-matrix) measures what
that dependence is actually worth: `require('node:http')` through
`Module._load` survived every rung including the broken window, but
`import 'node:http'` has **never** flowed through `Module._load` on any
version — the patch point was never sufficient for ESM consumers by design.
So a builtin strategy needs neither loader hooks nor the patch point: a
declarative config knows its targets up front, and the runtime shell patches
them **eagerly at preload**, mutating the builtin's exports object before any
user code loads:

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
the same reach split as the [orchestrion comparison](comparisons.md).)
