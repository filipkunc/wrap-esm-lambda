---
marp: true
theme: default
class: invert
paginate: true
style: |
  section { padding: 56px 72px; }
  h1 { color: #7dd3fc; }
  h2 { color: #bae6fd; }
  strong { color: #fbbf24; }
  code { background: #172033; }
  table { font-size: 24px; }
---

# Patching Node.js modules at their exports

## One declarative model for ESM, CommonJS, runtime hooks, and bundlers

`wrap-esm-lambda`

---

# Instrumentation should describe intent, not loader machinery

An integration usually knows four things:

- the **package and version** it supports
- the **files** that expose the useful API
- the exported **bindings** it needs
- the **patch function** that wraps or replaces them

The difficult part is delivering that intent consistently across `import`,
`require()`, serverless runtimes, and build pipelines.

---

# A patch entry is the shared contract

```js
{
  module: {
    name: '@smithy/core',
    versionRange: '>=3 <5',
    files: ['dist-es/.../client.js', 'dist-cjs/.../index.js'],
  },
  patch: { name: 'patchClient', from: './patches/aws.mjs' },
  bindings: ['Client'],
}
```

The entry is plain data. Runtime hooks and bundler plugins consume the same
config and apply the same transform.

---

# The exports tap runs at the module boundary

The transform adds a small call at the end of a matched module's evaluation:

```js
patchClient({
  get Client() { return Client },
  set Client(value) { Client = value },
})
```

The patch runs **after the module defines its exports** and **before an
importer observes them**. Reading sees the live value; assigning rebinds it
for every consumer.

---

# Most modules take the append-only fast path

| Export shape | Transform |
| --- | --- |
| Mutable local — function, class, `let`, `var` | Append the tap only |
| `export const` or anonymous default | Rewrite into a rebindable local |
| Re-export or `export *` chain | Resolve the provider, then expose a local |
| CommonJS with a top-level `return` | Use an evaluation wrap, then tap |

Requested bindings are validated first. A missing or ambiguous export is a
version-drift signal, not a silent no-op.

---

# One engine supports two delivery modes

## Runtime

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs \
  node --import @wrap-esm-lambda/hooks/register app.mjs
```

Node's synchronous load hooks transform matching modules as they load.

## Build time

The same config goes to `@wrap-esm-lambda/unplugin` adapters for esbuild,
Rollup, Rolldown, Vite, webpack, and Rspack. The patch is bundled with the app,
so no runtime hook is required.

---

# The tap closes gaps left by neighboring mechanisms

| Capability | `Module._load` patch | Loader proxy | Exports tap |
| --- | ---: | ---: | ---: |
| ESM `import` | Partial | Yes | Yes |
| Pure `require()` chain | Yes | No | Yes |
| Rebind exported API | Yes | Yes | Yes |
| Reach non-exported internals | No | No | No |
| Build-time delivery | No | No | Yes |

Body-rewriting transforms can reach non-exported internals, but solve a
different problem and perform substantially more work per matched module.

---

# Platform presets turn runtime facts into ordinary entries

## AWS Lambda

The `aws-lambda` preset reads `_HANDLER` and `LAMBDA_TASK_ROOT`, discovers the
handler file and export, and emits a path-matched patch entry. The config stays
inert outside Lambda.

## Azure Functions

The `azure-functions` preset brackets the platform's own
`preInvocation`/`postInvocation` pipeline instead of rewriting the handler.

The platform-specific logic stops at discovery; the patch model stays the
same.

---

# Two engines uphold one output contract

- **OXC engine** — native Rust addon, optimized for production transforms
- **Acorn engine** — pure JavaScript fallback for unsupported native targets
- byte-identical tap snippets and equivalent rewrite semantics
- source maps preserved or regenerated, including upstream TypeScript maps
- comments with bundler meaning remain intact

The delivery shell selects the engine. Patch authors do not write
engine-specific integrations.

---

# Instrumentation fails soft—unless strict mode is requested

- a drifted binding, throwing patch, or unavailable engine is isolated
- every recovered failure is reported and queryable
- `WRAP_ESM_LAMBDA_DISABLE=1` is the operational kill switch
- `WRAP_ESM_LAMBDA_STRICT=1` turns recovery into CI failures
- `wrap-esm-lambda-validate` checks configs before deployment

The goal is to protect application startup without hiding compatibility
regressions from maintainers.

---

# The core idea

**Describe the module boundary once. Deliver the same patch wherever the
module graph is built.**

- Start: [`docs/getting-started.md`](../getting-started.md)
- Mechanism: [`docs/how-it-works.md`](../how-it-works.md)
- Configuration: [`docs/config.md`](../config.md)
- Evidence: [`docs/real-packages.md`](../real-packages.md)
- Trade-offs: [`docs/comparisons.md`](../comparisons.md)
