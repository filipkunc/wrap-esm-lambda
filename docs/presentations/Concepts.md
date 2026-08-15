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
  blockquote { border-color: #fbbf24; font-size: 28px; }
---

<!-- _class: lead -->

# What if writing instrumentation did not mean writing a compiler?

## The idea behind `wrap-esm-lambda`

---

# The patch we want to write is usually the easy part

Suppose every AWS SDK request should pass through our wrapper:

```js
export function patchClient({ Client }) {
  const original = Client.prototype.send
  Client.prototype.send = function (command, ...rest) {
    return trace(command, () => original.call(this, command, ...rest))
  }
}
```

That code says exactly what the integration does. It should be most of the
work an instrumentation author has to own.

---

# Reaching that class is where compiler work begins

Without a shared transform, every integration needs some version of this:

```js
const ast = parse(source)
const exported = findExport(ast, 'Client')
const local = resolveBinding(exported)
makeReassignable(local)
appendPatchCall(ast, './patches/aws.mjs')
return { code: print(ast), map: generateMap(ast) }
```

And then the real cases arrive: CommonJS, re-exports, `export const`, star
barrels, source maps, semantic comments, and different bundlers.

> The AST is infrastructure. It should not leak into every patch.

---

# The declarative entry draws the boundary instead

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

The author names **where the API lives** and **which exports the patch needs**.
The engine owns the syntax needed to make those exports patchable.

---

# The exports tap turns that intent into live access

For an ordinary class export, the generated code is conceptually this small:

```js
patchClient({
  get Client() {
    return Client
  },
  set Client(value) {
    Client = value
  },
})
```

It runs after the module has created its exports, but before an importer sees
them. The patch can mutate the class, wrap it, or replace it altogether.

---

# Easy modules stay untouched; awkward exports become the engine's problem

```js
// already reassignable
export class Client {}

// needs a rewrite
export const Client = class {}

// provider may live several files away
export * from './client.js'
```

The first shape only gets an appended tap. The others are rewritten once,
with their source maps and meaningful comments preserved.

The patch author still asks for `Client` in exactly the same way.

---

# The same declaration works before or during execution

## At runtime

```sh
WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs \
  node --import @wrap-esm-lambda/hooks/register app.mjs
```

The tap is added while Node loads the matching module.

## At build time

The same config goes to the bundler plugin. The transformed module and patch
are bundled into the application, so no runtime hook is needed.

---

# Why not use Orchestrion instead?

Both tools can describe the same target without hand-written AST traversal:

```js
// Orchestrion: publish lifecycle events from Client#send
{
  channelName: 'smithy-send',
  functionQuery: { className: 'Client', methodName: 'send' },
}

// exports tap: hand the live Client binding to patchClient
{ bindings: ['Client'], patch: { name: 'patchClient', from: './aws.mjs' } }
```

The difference is not **declarative versus imperative**. It is what the
declaration lets user code do next.

---

# Observation and intervention solve different problems

```js
const result = await new Client().send('hello')

// Orchestrion
// result === 'sent:hello'          + start/end events

// exports tap
// result === 'patched:sent:hello'  after patchClient wraps send
```

Orchestrion's diagnostic-channel subscriber observes the lifecycle; it cannot
replace the method's return value. That is a good fit for event-based tracing,
and its body rewrite can even reach **non-exported functions and call sites**.

The exports tap chooses a narrower boundary but gives the patch the actual
binding. It can wrap, short-circuit, or replace behavior when observation is
not enough.

---

# Acorn answers an important question: how far can pure JavaScript go?

The Acorn engine is not merely an emergency fallback. It implements the same
contract in JavaScript and gives the native engine an honest control case.

On the same real `@smithy/core` ESM module:

| Transform                | Approximate latency |
| ------------------------ | ------------------: |
| OXC exports tap          |           **14 µs** |
| Acorn exports tap        |           **86 µs** |
| Orchestrion body rewrite |     **950–1200 µs** |

Pure JavaScript is still roughly **11× ahead of the body-rewriting approach**.
That shows the largest win comes from the tap's architecture, not from Rust.

---

# Rust earns its place where parsing dominates

OXC takes the same design from roughly **86 µs to 14 µs** on that module—about
a **6× improvement** in the parse-heavy transform.

The cold-start difference is much smaller: the Acorn setup adds roughly
**14 ms**, because process startup and package loading dominate there.

So the two engines make the trade-off visible:

- Acorn proves the design is viable in pure JavaScript.
- OXC pays off when many or larger modules need full parsing.

---

# Choosing the exports boundary closes two practical gaps

Traditional `Module._load` patching follows `require()`, but cannot cover the
whole ESM world. Loader proxies cover ESM imports, but never see a pure
`require()` chain—the path the AWS SDK commonly takes.

The exports tap changes the module source itself, so the result is already in
place whichever route consumes it:

```text
ESM import ─┐
            ├─ sees the patched export
require() ──┘
```

The same mechanism also works when a bundler owns the module graph.

---

# Lambda was the first use case, not the final abstraction

Lambda decides the handler file and export through `_HANDLER` and
`LAMBDA_TASK_ROOT`. The AWS preset turns those runtime facts into an ordinary
path-matched entry, then the same tap does the patching.

That original problem led to the more general question:

> Can instrumentation describe the module boundary once, without caring who
> loads it?

The declarative config is the answer shared by Lambda, regular Node processes,
and build pipelines.

---

# Keep the compiler machinery in one place

Patch authors should spend their time on the behavior they want to add—not on
AST traversal, module-format edge cases, or source-map repair.

`wrap-esm-lambda` keeps those mechanics behind one declaration and tests them
against both a pure-JavaScript engine and a native one.

- Start: [`docs/getting-started.md`](../getting-started.md)
- Mechanism: [`docs/how-it-works.md`](../how-it-works.md)
- Measurements: [`docs/benchmarks.md`](../benchmarks.md)
- Trade-offs: [`docs/comparisons.md`](../comparisons.md)
