# Config reference

A config is a list of patch entries, defined with
`definePatches`/`defineConfig` from
[`@wrap-esm-lambda/core`](../packages/core) and shared verbatim by the
runtime shell ([`@wrap-esm-lambda/hooks`](../packages/hooks)) and the
build-time shell ([`@wrap-esm-lambda/unplugin`](../packages/unplugin)).

## Patch entries — the exports tap

```ts
{
  module: {
    name: '@smithy/core',        // package name (nearest package.json) — or a builtin ('node:os')
    versionRange: '>=3 <5',      // optional semver gate (builtins: gates on process.versions.node)
    files: ['dist-es/submodules/client/smithy-client/client.js', 'dist-cjs/submodules/client/index.js'],
                                 // optional path suffixes; omit = every file of the package
  },
  patch: { name: 'patchSmithyClient', from: '/abs/path/patches/aws.ts' },
  bindings: ['Client'],          // exports handed to the patch; 'module.exports' rebinds the whole CJS export
}
```

- `patch.from` may be relative to the config file, a bare package specifier,
  a `file://` URL or an absolute path — pass `import.meta.url` as the second
  argument of `defineConfig`/`definePatches` and everything is resolved to an
  absolute path at definition time (resolution rules in the
  [patch author contract](../packages/core/README.md#patch-author-contract)).
  TypeScript patch files ride on Node's type stripping at runtime and on the
  bundler at build time.
- **Path-identified targets**: `module: { path: [...] }` (a string or list;
  an absolute path matches exactly, a relative one as a suffix) matches files
  instead of a package, for code with no useful package identity — an app's
  own files, or a Lambda handler whose location only the runtime environment
  knows (the [aws-lambda preset](../packages/hooks/README.md#aws-lambda)
  derives such an entry from `_HANDLER`/`LAMBDA_TASK_ROOT` at preload).
  `path` replaces `name` and excludes `versionRange`/`files`; the validator
  checks whichever candidates exist in the local tree and skips the rest as
  runtime-only.
- **Builtin targets** (`node:http`, `os`, ...) have no source to transform,
  so each shell reaches them through what it owns. The runtime shell patches
  their exports object **eagerly at preload**, before any user code loads.
  The build shell owns module **resolution** instead: every configured
  builtin specifier is aliased to a generated wrapper module that patches
  the real exports object via `process.getBuiltinModule` (Node >= 22.3
  where the bundle runs) and re-exports the patched bindings. In both modes
  `require()`, ESM default import and ESM named import all observe the
  patch, and a shared guard keeps the hybrid combination single-patched.
  Builtin entries reject `files`; `versionRange` gates on the running Node
  at preload and on the building Node at bundle time.
- Validation is loud: a requested binding missing from an ESM module (or a
  builtin) is a hard error, and a rebind that cannot take effect (getter-only
  CJS exports of a sloppy-mode bundle) throws instead of silently no-opping.

Patch entries are the only entry kind. Earlier versions had a second one —
**wrap entries** (`match` + `handler` + `wrapper`), the original
Lambda-handler transform — removed once the tap's rewrite path could rebind
every shape they covered and the
[aws-lambda preset](../packages/hooks/README.md#aws-lambda) covered the
runtime discovery. A wrap entry translates directly: a
`module: { path: [...] }` match, `bindings: [<handler>]`, and a one-line
patch function `bindings.handler = WrapAwsLambda(bindings.handler)`.

## Platform presets

Two presets in `@wrap-esm-lambda/hooks` generate entries (or register
platform hooks) from the platform's own environment contract instead of
hand-written config, and are inert off-platform:

- [`aws-lambda`](../packages/hooks/README.md#aws-lambda) —
  `lambdaHandlerEntries(...)` wraps the function's handler discovered from
  `_HANDLER`/`LAMBDA_TASK_ROOT`.
- [`azure-functions`](../packages/hooks/README.md#azure-functions) —
  `azureFunctionsEntries(...)` brackets the v4 model's
  `preInvocation`/`postInvocation` pipeline with per-invocation timing and
  attribution.

## Shipping instrumentation as a package

A config is code, and `from` specifiers resolve against the config file — so
patch code, config and activation ship together as **one ordinary npm
package**, the way an APM vendor distributes instrumentation:

```
your-apm/
  package.json          exports: { "./register": ..., "./config": ... }
  src/patches/*.mjs     the patch functions (no dependency on this toolkit)
  src/config.mjs        definePatches([...], import.meta.url)
  src/register.mjs      import { registerConfig } from '@wrap-esm-lambda/hooks'
                        import config from './config.mjs'
                        await registerConfig(config)
```

The app installs the package and the whole runtime integration is one flag —
no config file, no env var:

```sh
node --import your-apm/register app.mjs
```

Alternatively `WRAP_ESM_LAMBDA_CONFIG` accepts a package specifier (resolved
from the app, like any dependency):

```sh
WRAP_ESM_LAMBDA_CONFIG=your-apm/config node --import @wrap-esm-lambda/hooks/register app.mjs
```

…and the same installed config drives build-time delivery through the
unplugin adapters. Because entries are plain data, an app composes several
instrumentation packages by concatenating their entries. The runnable version
of this pattern is
[examples/function-logger](../examples/function-logger) — a before/after call
logger with exception capture (logged and rethrown), consumed by
[examples/function-logger-app](../examples/function-logger-app) and verified
end-to-end (both runtime activations plus the bundled build) by
[`__test__/packaging.spec.ts`](../__test__/packaging.spec.ts).
