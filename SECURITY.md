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
