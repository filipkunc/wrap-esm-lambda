# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/filipkunc/wrap-esm-lambda/security/advisories/new)
rather than opening a public issue. Expect an acknowledgement within a few days.

## Supported versions

The `0.x` line is pre-1.0: fixes land on `main` and ship in the next release.
There are no maintained release branches yet.

Node.js: the versions CI runs — 22, 24 and 26. `@wrap-esm-lambda/hooks`
additionally requires >= 22.15, where `module.registerHooks` arrived.

## How this repository audits itself

[`security-audit.yml`](.github/workflows/security-audit.yml) runs on every push
and pull request — CI calls it, and `publish` waits on it — and again nightly,
so an advisory published against a dependency nobody touched surfaces without
waiting for the next commit.

| Check                    | On a finding                                           |
| ------------------------ | ------------------------------------------------------ |
| `pnpm audit --prod`      | Fails the build. Nothing published may be vulnerable   |
| `pnpm audit` (full tree) | Warns. Dev-only, no consumer is exposed                |
| `cargo audit`            | Vulnerabilities fail; unmaintained/yanked/unsound warn |
| CodeQL (JS/TS)           | Opens a code scanning alert                            |

Findings are reported three ways: as check-run annotations on the run itself
(anchored to the offending `pnpm-lock.yaml` / `Cargo.lock` line, so they render
inline on a pull request's diff), as a table in the job summary, and as code
scanning alerts, which is the only one of the three that survives the run and
can be dismissed with a reason.

Renovate raises dependency updates. Vulnerability fixes are exempted from the
usual grouping and scheduling so a security bump gets its own pull request
immediately rather than waiting for the next batch.

Three things cannot be configured from this repository and have to be switched
on in the repository's own settings — if you are maintaining a fork, they are
worth checking:

- **Dependabot alerts**, which back Renovate's vulnerability pull requests.
  (Renovate also reads the OSV database directly, so this is redundancy rather
  than a hard dependency.)
- **Private vulnerability reporting**, without which the reporting link at the
  top of this file does not work.
- **Secret scanning and push protection.**

## What this project's threat model is

This toolkit **rewrites the source of modules as they load, or as they are
bundled**, and runs configured patch functions inside the process it
instruments. That is its purpose, and it means:

- A config is code. `defineConfig` / `definePatches` resolve `patch.from` and
  `wrapper.from` at definition time and the runtime shell imports them, so a
  config controls what executes at startup. Treat a config file — and any
  package a `WRAP_ESM_LAMBDA_CONFIG` specifier resolves to — with the same care
  as the application's own entry point.
- Patch functions run with the privileges of the application. There is no
  sandbox, by design; a patch is ordinary code operating on live bindings.
- `WRAP_ESM_LAMBDA_DISABLE=1` turns the whole runtime shell off, including
  config resolution, without changing the start command. That is the lever for
  taking instrumentation out of a running deployment.

Vulnerabilities worth reporting therefore look like: the transform emitting
code that changes a module's behaviour beyond the configured patch; the tap
reading or writing outside the module it was pointed at; a crafted module
source causing the transform to emit something the config did not ask for; or
the runtime shell loading patch code from somewhere other than the resolved
`patch.from`.

Bugs where a _config author_ instruments something they should not are not
vulnerabilities — that is the tool doing what it was told.
