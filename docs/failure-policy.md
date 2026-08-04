# Failure policy: what happens when instrumentation cannot do its job

Instrumentation sits in the load path of every module of a process it does not
own, so the question that decides whether it is deployable is not "does the
patch work" but "what happens when it doesn't" — a binding renamed in a
dependency bump, a patch function with a bug in it, a platform with no
prebuilt addon.

The rule: **fail soft wherever partial degradation exists, stay loud where
there is nothing to degrade to.** Downstream of a valid config, every failure
costs exactly what it has to and no more.

| what fails                                       | what it costs                                       |
| ------------------------------------------------ | --------------------------------------------------- |
| the native addon cannot be loaded                | the process runs on the pure-JS acorn engine        |
| a patch module will not import                   | that one entry drops; the other entries still apply |
| a requested binding is gone (version drift)      | that one module loads untouched                     |
| a patch function throws                          | that one patch call; the patched module still loads |
| a builtin's binding moved                        | that one builtin patch                              |
| `module.registerHooks` is missing (Node < 22.15) | the load hook; eager builtin patches still apply    |
| the config cannot be found or loaded             | **startup** — loud, on purpose (see below)          |

Every recovered failure reports once on stderr and is retrievable
programmatically, so "is this process fully instrumented?" has an answer:

```js
import { instrumentationFailures } from '@wrap-esm-lambda/core'
// { total: 1, entries: [{ what: "instrumenting file:///...", error: [Error] }] }
```

## Validating ahead of time

`wrap-esm-lambda-validate` asks the same questions against the installed
tree — package present, version in range, declared files there, ESM exports
still exported, patch module importable — and exits non-zero on any failure,
so drift is a CI failure in your repo rather than absent telemetry later:

```sh
npx wrap-esm-lambda-validate ./wrap.config.mjs
#   ERROR   hono >=4 <5 · dist/hono.js
#           installed 4.12.31; dist/hono.js: 'Hono' not exported (available: HonoBase)
```

It claims only what static analysis can: a CJS target reports _unverifiable_
rather than passing, because its exports are assembled at runtime — the same
reason the CJS tap validates nothing and reaches through `module.exports`.

## The switches

| variable                    | effect                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRAP_ESM_LAMBDA_DISABLE=1` | kill switch: no hooks, no patches, no transform — and the config is never resolved, the addon never loaded. Mitigates an incident without touching the app's start command. |
| `WRAP_ESM_LAMBDA_STRICT=1`  | every recovered failure throws instead. What CI runs; also how to find out why a patch is silently not applying.                                                            |
| `WRAP_ESM_LAMBDA_DEBUG=1`   | trace the decisions — engine bound, modules instrumented, entries skipped — to stderr.                                                                                      |

## The two loud exceptions

Two deliberate exceptions to the soft default. **Config resolution is loud**:
unlike a drifted binding it has nothing to degrade to, and an operator who
passed `--import` should learn at startup that they got no instrumentation, not
from absent telemetry hours later — `WRAP_ESM_LAMBDA_DISABLE=1` is the way to
say "not now". And **the build-time shell keeps throwing**: a failing build is
visible and cheap, a silently un-instrumented artifact is not.

## Engine selection

Engine availability is not governed by strict mode but by
`WRAP_ESM_LAMBDA_ENGINE`: unset means "native, or the JS engine if the addon
cannot be loaded", while naming an engine (`oxc`, `acorn`) means "this one or
fail". CI names it, so a broken native build can never pass as a green acorn
run. Details on the two engines and the lazy binding are in the core README's
[Choosing the engine](../packages/core/README.md#choosing-the-engine).
