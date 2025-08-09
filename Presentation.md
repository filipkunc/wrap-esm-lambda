---
marp: true
theme: default
class: invert
---

# Wrapping AWS Lambda ESM `handler`

The problem: How to transform AWS Lambda `handler` below?

```js
// input.js
export const handler = async(event) => {
    return "Hi from AWS Lambda";
};
```

To the following, notice the `WrapAwsLambda` wrapper:

```js
// transformed.js
export const handler = WrapAwsLambda(async(event) => {
    return "Hi from AWS Lambda";
});
```

---

# Using loader hooks

Built-in Node.js mechanism to hook into the ESM `import`: https://nodejs.org/api/module.html#customization-hooks

## Asynchronous hooks

```js
// register_async_hooks.mjs
import { register } from "node:module";
register("./async-hooks.mjs", import.meta.url);
```

Add `--import` to register hooks:

```sh
node --import ./register_async_hooks.mjs runtime.mjs
```

_The hooks `load` function runs on a dedicated thread!_

---

# Async hooks `load` function

```js
// async_hooks.mjs
import { transformLambda } from "./myTransform.js";
let patched = false;
export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (!patched && url.endsWith("/handler.mjs")) {
        patched = true;
        return {
            format: "module", shortCircuit: true,
            source: transformLambda(result.source.toString(), "handler", "WrapAwsLambda")
        };
    }
    return result;
}
```

_Note: async hooks are usually 2x slower than sync hooks._

---

# Synchronous hooks `load` function

```js
// sync_hooks.mjs
import { registerHooks } from "node:module";
import { transformLambda } from "./myTransform.js";
let patched = false;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!patched && url.endsWith("/handler.mjs")) {
      patched = true;
      return {
        format: "module",
        shortCircuit: true,
        source: transformLambda(result.source.toString(), "handler", "WrapAwsLambda")
      };
    }
    return result;
  },
});
```

---

# Transforming ESM source code

Naive approach using `RegExp()` for direct string manipulation:

```ts
// regex-transform.ts
export function transformLambda(input: string, handler: string, wrapper: string): string {
  return input.replace(
    new RegExp(`export const ${handler} = (.+);`, "s"),
    `export const ${handler} = ${wrapper}($1);`
  );
}
```

This is the fastest way, which we will use as baseline for AST transformations.

---

# Babel transform

Babel transformation with custom `visitor` is used to generate the wrapper call:

```ts
// babel-transform.ts
ExportNamedDeclaration(path) {
  if (t.isVariableDeclaration(path.node.declaration)) {
    const varDecl = path.node.declaration.declarations[0];
    if (t.isIdentifier(varDecl.id) && varDecl.id.name === handler) {
      path.replaceWith(t.exportNamedDeclaration(
        t.variableDeclaration("const", [t.variableDeclarator(t.identifier(handler),
          t.callExpression(t.identifier(wrapper), [varDecl.init!]))]
      )));
      path.skip();
    }
  }
}
```

---

# Acorn => estraverse => astring

Acorn is only a parser, `estraverse` and `astring` adds traversing and codegen.

```ts
const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: "module" });
estraverse.replace(ast as ESTree.Node, {
  enter: function (node) {
    if (node.type === "ExportNamedDeclaration" 
     && node.declaration?.type === "VariableDeclaration") {
      const varDecl = node.declaration.declarations[0];
      if (varDecl.id.type === "Identifier" && varDecl.id.name === handler) {
        varDecl.init = NESTree.CallExpression(Helpers.AutoChain(wrapper),
          [varDecl.init as NESTree.Expression]) as ESTree.Expression;
      }
      return { ...node };
    }
  }
});
return astring.generate(ast);
```

---

# Rust native addon using `oxc.rs`

The [oxc.rs](https://oxc.rs/) tools and crate [`oxc_transformer`](https://oxc.rs/docs/guide/usage/transformer.html) provides API similar to Babel in Rust.

With [napi.rs](https://napi.rs/) we can easily export the Rust code:

```rust
use napi_derive::napi;
mod transform;

#[napi]
pub fn transform_lambda(input: String) -> String {
  transform::transform_lambda_source(input)
}
```

```js
const output = transformLambda(input);
```

---

# Rust wasm plugin for `swc.rs`

Based on the [SWC](https://swc.rs/) guide for [plugin creation](https://swc.rs/docs/plugin/ecmascript/getting-started) compiled to WebAssembly.

```js
// swc-wrapper.cjs
const swc = require("@swc/core");
exports.transformLambda = function (sourceCode, handler, wrapper) {
  const output = swc.transformSync(sourceCode, {
    filename: "handler.mjs", sourceMaps: false, isModule: true, {
      target: "esnext", experimental: {
        plugins: [[ require.resolve("./my-plugin.wasm"), { handler, wrapper } ]]
      }
    },
  });
  return output.code;
};
```

---

# Benchmark

Benchmark table via [hyperfine](https://github.com/sharkdp/hyperfine) and `usr/bin/time -v` for Max RSS:

| Hooks | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| N/A | 33.6 ± 3.5 | 29.0 | 46.1 | 1.00 | 44.53 |
| RegExp | 34.5 ± 3.7 | 28.3 | 46.4 | 1.03 ± 0.15 | 44.69 |
| oxc.rs | 47.5 ± 3.4 | 42.9 | 57.5 | 1.41 ± 0.18 | 56.09 |
| Acorn | 65.2 ± 9.3 | 54.9 | 96.3 | 1.94 ± 0.34 | 54.76 |
| swc.rs | 214.0 ± 25.1 | 162.8 | 253.0 | 6.37 ± 1.00 | 314.00 |
| Babel | 216.4 ± 27.5 | 174.4 | 279.3 | 6.44 ± 1.06 | 77.45 |
