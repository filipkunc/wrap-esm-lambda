# Changelog

Notable changes to `wrap-esm-lambda` and the `@wrap-esm-lambda/*` packages. The
`0.x` line makes no compatibility promises yet; entries call out anything that
would break a consumer.

## Unreleased

### Failure policy

- Instrumentation failures no longer take the host process down. A patch module
  that will not import drops its own entry, a module whose transform throws
  loads untouched, a patch function that throws is contained (at runtime by the
  registered wrapper, in a bundle by a guard emitted with the call), and a
  builtin whose binding moved is skipped. Every case reports once on stderr and
  is retrievable via `instrumentationFailures()`.
- `WRAP_ESM_LAMBDA_STRICT=1` restores the hard failure for all of the above;
  `WRAP_ESM_LAMBDA_DISABLE=1` turns the runtime shell off entirely before the
  config is resolved or the addon loaded; `WRAP_ESM_LAMBDA_DEBUG=1` traces
  engine selection, matches, skips and rewrites.
- A native addon that cannot be loaded degrades to the pure-JS acorn engine
  with a warning instead of throwing out of `--import`. Naming an engine
  (`WRAP_ESM_LAMBDA_ENGINE=oxc`) opts out of the substitution.
- The addon now reports a transform contract version, and core refuses an
  engine that disagrees — a mismatch is treated like an unloadable addon.
- **Behaviour change:** two previously fatal cases are now reported and
  survived by default — a rebind that no-ops on getter-only bundled CJS, and a
  binding missing from a matched module. Set `WRAP_ESM_LAMBDA_STRICT=1` for the
  old behaviour.

### Added

- Patch entries can match by **path** instead of package identity:
  `module: { path: [...] }` (absolute paths match exactly, relative ones as
  suffixes — the `files` rule) for code with no useful package name, such as
  an app's own files. `path` replaces `name` and excludes
  `versionRange`/`files`; `wrap-esm-lambda-validate` checks candidates that
  exist locally and skips the rest as runtime-only.
- `@wrap-esm-lambda/hooks/aws-lambda`: `lambdaHandlerEntries()` derives a
  path-matched patch entry for a Lambda function's own handler from
  `_HANDLER`/`LAMBDA_TASK_ROOT` at preload, reproducing the runtime
  interface client's resolution rules (basename split on the first dot,
  module-root prefix, the `''`/`.js`/`.mjs`/`.cjs` lookup order, first
  property segment as the tapped binding). The original Lambda-handler use
  case now runs entirely on the generic exports tap — no wrap entry, no
  static handler knowledge; outside Lambda the preset emits no entry, so
  the config is inert. Verified end-to-end against the RIC's load sequence
  in `__test__/lambda-generic.spec.ts` and through AWS's real runtime
  interface client on the `public.ecr.aws/lambda/nodejs` images in the CI
  Lambda lane.
- `wrap-esm-lambda-validate` (a `bin` of `@wrap-esm-lambda/core`): checks a
  config against the installed tree — package present, version in range,
  declared files present, ESM exports still there, patch module importable —
  and exits 1 on any error, 2 when the config could not be read at all.

### Packaging

- The four workspace packages are TypeScript (`src/*.mts`) and ship compiled
  ESM plus declarations, so `definePatches` and friends are typed for
  consumers.
- `chart.js` moved out of the published addon's runtime dependencies; it was
  only ever used by the benchmark chart scripts.
- The native addon became an _optional_ dependency of `@wrap-esm-lambda/core`,
  which the acorn fallback makes safe.
- `engines.node` now states what is actually tested (>= 22, and >= 22.15 for
  `@wrap-esm-lambda/hooks`).
- Windows fix: a wrap entry's injected import is emitted as a `file://` URL for
  the runtime shell, since Node parses an import specifier as a URL and a
  drive-letter path is not one.

### CI

- The suite runs on Node 22, 24 and 26 across linux-x64, linux-arm64,
  linux-x64-musl, linux-arm64-musl, win32-x64-msvc and darwin-arm64, plus the
  WASI build and a lane with no native artifact at all. Both engines run on
  every native lane.
- Gates added: `clippy -D warnings`, `oxlint --deny-warnings`,
  `prettier --check`, `tsc --noEmit` over the specs, and a pack-and-install
  check that the published tarballs actually work.
- Benchmarks no longer run in the publish job, and publishing to npm requires a
  manual workflow dispatch with an explicit confirmation.
