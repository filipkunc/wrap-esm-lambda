# examples/pkg-pr-new — consuming the toolkit from outside this repo

Two minimal tutorial projects that use the published packages **exactly as a
project outside this repository would** — one per delivery mode:

- [`runtime/`](runtime) — runtime instrumentation: `@wrap-esm-lambda/hooks`
  and one `node --import` flag, zero build changes
- [`unplugin/`](unplugin) — build-time instrumentation:
  `@wrap-esm-lambda/unplugin` driving esbuild, zero runtime cost

Both patch the same target — [hono](https://hono.dev), a modern dual
package (native ESM plus bundled CJS) — from the same three files (app,
config, patch function), so diffing the two directories shows precisely what
switching delivery mode costs: one dependency and one activation line.
Nothing else changes.

## Compatibility package check

The native addon moved from `wrap-esm-lambda` to
`@wrap-esm-lambda/engine-oxc` in 0.4.0. The old name is still published as a
small forwarding package, so existing lockfiles and imports do not break only
because the package was renamed.

Both tutorials list the old and new addon names as optional preview
dependencies and include the same explicit check:

```sh
npm run check:compat
```

That command loads both names and asserts that the compatibility package
returns the exact module object—and therefore the complete API—of the scoped
addon. The dependencies are optional because the tutorials still demonstrate
the Acorn fallback on unsupported platforms. CI makes the OXC engine mandatory
for a freshly published preview and runs this compatibility assertion before
the tutorial itself.

New applications should use `@wrap-esm-lambda/engine-oxc`; the unscoped name
exists to make migration safe.

## Where the packages come from

Neither project uses `workspace:^` links. Their dependencies point at
[pkg.pr.new](https://pkg.pr.new) preview tarballs:

```
https://pkg.pr.new/filipkunc/wrap-esm-lambda/@wrap-esm-lambda/core@main
```

CI publishes a preview of every package on **every green push to `main`**
(the "Publish preview" step in [CI.yml](../../.github/workflows/CI.yml)), and
pkg.pr.new rewrites the inter-package references — the `workspace:^` links
_and_ the native addon's per-platform `optionalDependencies` — to its own
commit-keyed tarball URLs. So a plain `npm install` on any machine pulls the
whole dependency chain, prebuilt native binaries included, with no registry,
no token and no local Rust toolchain.

The `@main` tag always resolves to the latest green `main` commit. To pin a
specific commit or try a PR's build instead, swap the suffix:

| suffix      | resolves to                             |
| ----------- | --------------------------------------- |
| `@main`     | the newest preview published for `main` |
| `@<sha>`    | that exact commit's preview             |
| `@<number>` | that pull request's latest preview      |

(Commit and PR previews exist only where CI's publish job ran — pushes to
`main` and manual dispatches. If an install 404s, no preview was published
for that ref.)

## Running them

Because these projects deliberately live **outside the pnpm workspace**
(`pnpm-workspace.yaml` matches `examples/*`, one level up), the repo's own
`pnpm install` never touches them and they carry no links back into the
checkout. Each is self-contained — copy the directory anywhere, then:

```sh
cd runtime   # or unplugin
npm install
npm start
```

Once the packages are released on npmjs, the tutorial flow is identical with
version ranges in place of the preview URLs.

## Tested in CI, and deliberately not published

These directories are consumed by CI, never published: the preview upload's
globs (`'.'`, `'./npm/*'`, `'./packages/*'`) don't touch `examples/`, and
every published package has a `files` whitelist besides — the previews the
tutorials install can never contain the tutorials themselves. The
`tutorial-previews` job in [CI.yml](../../.github/workflows/CI.yml) proves
both directions: on every push to `main` it runs both tutorials with plain
npm against that commit's own freshly uploaded previews, and on every pull
request against the committed `@main` URLs exactly as a reader would
install them — checking the patched output either way, asserting the old and new addon names
against freshly published previews, and failing if a tutorial file ever leaks
into an installed package.
