# History: why source transform, and the Frida detours that were removed

This project's runtime shell is built on synchronous `module.registerHooks()`
because every earlier patch point in Node's module loading kept breaking.
This page keeps the receipts: the breakage trail that motivated the design,
and the fs-level Frida fallback the project once carried as insurance.

## Frida hooking (removed)

Earlier versions carried a [Frida](https://frida.re/)-based fallback: `libc`
`open`/`read` and `uv_fs_fstat` detours (installed via `LD_PRELOAD` or an
`installHooks()` export) that rewrote `handler.mjs` at file-read time,
underneath the module system entirely. It existed as insurance for an era
when patching Node's module loading kept breaking under Node's own refactors:

- [nodejs/node#21573](https://github.com/nodejs/node/pull/21573) switched the
  CJS loader from `Module.wrap` to `vm.compileFunction`, silently bypassing
  tools that patched the wrapper (the nyc/istanbul-style breakage, still
  echoing years later in
  [nodejs/node#49653](https://github.com/nodejs/node/issues/49653));
- the Node 20.6 loader restructure
  ([nodejs/node#47999](https://github.com/nodejs/node/pull/47999)) moved
  `import`-ed CJS off the monkey-patchable `Module._load` path and shipped
  regressions like
  [nodejs/node#49497](https://github.com/nodejs/node/issues/49497);
- as recently as v24.15.0,
  [nodejs/node#62786](https://github.com/nodejs/node/issues/62786) broke
  `require.extensions`-reading tools (pirates, ts-node, Next's require hook)
  for CJS served through the ESM loader;
- even `registerHooks` itself and `Module._load` went through a broken-interplay
  phase across Node 22.16–22.18 and the 23.x/24.x lines: registering sync hooks
  rerouted CJS off `Module._load` entirely (blinding `Module._load` patchers —
  demonstrated by [dygabo/load_module_test](https://github.com/dygabo/load_module_test)),
  plain hooks died with `ERR_INVALID_RETURN_PROPERTY_VALUE`
  ([nodejs/node#59384](https://github.com/nodejs/node/issues/59384)), combining
  `register()` with `registerHooks()` fed CJS a null source
  ([nodejs/node#57327](https://github.com/nodejs/node/issues/57327)), and the
  umbrella issue
  [nodejs/node#59666](https://github.com/nodejs/node/issues/59666) catalogued
  double-invoked sync hooks and a re-invented `require` missing
  `require.cache`. The cluster was fixed by
  [nodejs/node#59929](https://github.com/nodejs/node/pull/59929) (shipped in
  v22.22.3 / v24.11.1 / v25.1.0 — the same fix train behind iitm's sync-mode
  version floor noted in [comparisons.md](comparisons.md)) and
  [nodejs/node#60380](https://github.com/nodejs/node/pull/60380).
  [hooks/interplay-matrix](../hooks/interplay-matrix) reproduces this phase
  empirically (`node hooks/interplay-matrix/run.mjs`): across a ladder of
  official Node 22/24/26 builds, the `Module._load` blinding for `import`-ed
  CJS flips off at exactly 22.22.3/24.11.1, the hook-fed synthetic `require`
  still lacks `require.extensions`/`require.cache` on all of 22.x, and this
  library's source-transform tap passes on every rung — including the broken
  window. That last row is the operative point for AWS Lambda, whose managed
  runtimes trail nodejs.org minors on AWS's own cadence and so can sit below
  the fix (check `process.version` in a live function): on such a runtime,
  `Module._load`-based instrumentation silently loses `import`-ed CJS the
  moment sync hooks register, while the tap's behavior is identical on both
  sides of the fix.

That instability is exactly what
[nodejs/node#52219](https://github.com/nodejs/node/issues/52219) set out to
end, and its outcome — synchronous `module.registerHooks()`
([tracking issue nodejs/node#56241](https://github.com/nodejs/node/issues/56241)) —
is a supported API that sees both `require()` and `import` in-thread. This
library's runtime shell is built on it, so the fs-level detours no longer buy
any coverage the hooks lack, while costing native-only builds, `unsafe`
transmutes, and a fragile `uv_fs_fstat` signature (`libuv_sys2::uv_fs_t` has
no stable layout). The approach was removed; it survives in git history for
the archaeology.
