# Contributing / development guide

How to build, test and release this repo. The short version is in the README's
[building and running locally](README.md#building-and-running-locally); this
page keeps the details.

## Building and testing

1. `pnpm install` — install dependencies
2. `pnpm build` — build the native addon (`napi build --release`). **Required
   once after cloning**, and not only for the addon: the same command writes
   the package's entry point (`index.js`), its types (`index.d.ts`), and the
   wasi glue. Those are generated files and are not in git, so before the
   first build `../index` resolves to nothing and the typecheck fails.
   `pnpm build:debug` writes the identical set if you only need the loader.
3. `pnpm build:packages` — compile the workspace packages (`tsc -b`, project
   references, incremental); `pnpm test` runs it for you
4. `pnpm test` — the test suite, on Node's built-in
   [test runner](https://nodejs.org/api/test.html) (`node --test`; TypeScript
   specs load through `@oxc-node/core`)
5. `cargo fmt` and `cargo clippy` before committing
6. `cargo test` — Rust tests

The packages import each other by their published specifiers, so the suite
runs against the same `dist/` a consumer installs — `pnpm build:packages`
first, or the imports resolve to nothing.

All four workspace packages are written in TypeScript (`src/*.mts`) and ship
compiled ESM plus declarations (`dist/*.mjs` + `dist/*.d.mts`, with
declaration and source maps back to the `.mts`), so a config file gets real
completion on `definePatches`, and `TransformEngine` — the surface the native
addon and the acorn engine both implement — is a type the compiler checks
them against, not only a contract the parity tests assert.

## TypeScript

The repo is on **TypeScript 7**, the native Go compiler. Two migration details
are worth knowing before adding a `tsconfig.json`:

- `moduleResolution: "node"` (node10) was **removed** — it is a hard error
  (TS5108), not a deprecation warning.
- TypeScript 7 no longer auto-includes every `@types/*` package it can find, so
  ambient types must be named: `"types": ["node"]`. Omitting it does not fail
  loudly — it surfaces as a wall of `TS2591 Cannot find name 'process'` against
  code that is perfectly valid.

Editor support does **not** come from VS Code's built-in JavaScript/TypeScript
IntelliSense, which is tsserver-based and cannot drive a compiler that ships no
tsserver. Install the
[TypeScript Native Preview](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview)
extension (`.vscode/extensions.json` recommends it). It is a preview: auto-imports,
find-all-references and rename are incomplete.

## Generated files

`index.js`, `index.d.ts`, `browser.js`, `wasi-worker.mjs`,
`wasi-worker-browser.mjs`, `wrap-esm-lambda.wasi.cjs` and
`wrap-esm-lambda.wasi-browser.js` are emitted by `napi build` and are
gitignored. Any single build writes all of them — the set comes from
`napi.targets` in `package.json`, so a native x64 build produces the wasi glue
too.

They used to be committed, and that hid a real defect: the checked-in loader
still expected addon version `0.2.2` after the crate had moved to `0.2.3`.
Nothing regenerates them on a version bump and the publish job does not build,
so a release would have paired a `0.2.2` loader with `0.2.3` platform packages
— a version-mismatch throw for any consumer running with
`NAPI_RS_ENFORCE_VERSION_CHECK` set. In CI they now travel as the
`binding-glue` artifact, built once in the `build` job and downloaded by every
lane that resolves the package, so the bytes under test are the bytes
published.

## WebAssembly

1. `rustup target add wasm32-wasip1-threads` to install the build target
2. `pnpm build --target wasm32-wasip1-threads` to create the `.wasm` file

## CI

Every lane below runs the whole suite on **each** supported Node major —
`node@22`, `node@24`, `node@26` — except the Lambda lane, which tracks the
platform's runtimes rather than Node's release line:

| lane                                 | what it covers                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `linux-x64`, `linux-arm64`           | the prebuilt addon on both Linux arches, glibc and musl, in containers on native runners (no QEMU)       |
| **AWS Lambda**                       | the real `public.ecr.aws/lambda/nodejs` image — `nodejs22.x` and `nodejs24.x`, x86_64 and Graviton       |
| `win32-x64-msvc`, `win32-arm64-msvc` | Windows on both arches: drive letters and backslashes through matching, resolution and every child spawn |
| `darwin-arm64`, `darwin-x64`         | macOS on Apple silicon and Intel                                                                         |
| WASI                                 | the `wasm32-wasip1-threads` build — the reach onto platforms with no prebuilt addon                      |
| JS-only                              | **no native artifact at all**: the degraded engine path a platform without a prebuild takes              |

Every runner is native — the arm64 lanes are arm64 machines, not QEMU — so a
green lane means the artifact that platform downloads actually loads there.

The Lambda lane is the one that is not a proxy for its target: Amazon Linux
2023, AWS's own Node build, and a managed minor that moves on AWS's cadence
rather than nodejs.org's. Past the suite, it also runs the delivery shape the
platform forces and no other lane covers — the hook injected through
`NODE_OPTIONS` (the node CLI is not yours on a managed runtime) with the
runtime interface client's late, indirect handler load standing in as the
process main. There is deliberately no `node@26` row: no `nodejs26.x` runtime
exists, so the matrix gains one when AWS ships one.

Each native lane runs the suite twice, once per engine, and names
`WRAP_ESM_LAMBDA_ENGINE` explicitly — an implicit run would let a missing or
broken artifact pass as a green acorn run, since core falls back on purpose.
The acorn engine earns its second pass on Windows especially: it reimplements
import-style module resolution over `node:path`, which is where platform
differences actually live.

Gates in the lint job: `clippy -D warnings`, `oxlint --deny-warnings`,
`prettier --check`, `tsc --noEmit` over the specs, and `cargo test`. A
pack-and-install spec runs in every test lane, asserting that what the tarballs
ship is what the manifests promise and that an app built from those tarballs
alone actually instruments a package.

Two more gates run beside it, and both block a release:

- **MSRV** — `cargo check --all-targets --locked` on exactly the `rustc 1.95`
  that `rust-version` in `Cargo.toml` promises. Everything else Rust-side
  floats on stable, so without this a dependency raising the real floor would
  surface as a contributor's build breaking rather than as a red check.
- **Security audit** — `cargo audit` over the whole `Cargo.lock` (every crate
  there links into the shipped addon, so there is no dev/prod split to make),
  and `pnpm audit --prod` over what the published packages actually depend on.
  The full dev tree is audited too but never blocks: bundlers, the benchmark
  chart generator and test helpers carry advisories no consumer of this
  package is exposed to, and a gate that is always red is a gate nobody reads.

Every action is pinned to a commit SHA rather than a moving tag, with Renovate
configured to keep the digests current.

Not covered: 32-bit targets (Node ships no 32-bit Linux build, and win32-x86 is
being retired), armv7, FreeBSD, and `cargo test`/`clippy` anywhere but Linux.

## Releasing

Pushes and tags **dry-run** the release: `pnpm publish -r --dry-run` for the
workspace packages and `napi prepublish --dry-run` for the addon, so the
plumbing is exercised continuously without touching the registry. An actual npm
publish requires running the workflow manually and typing the confirmation —
nothing automatic can reach the registry.
