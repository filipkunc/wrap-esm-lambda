# `wrap-esm-lambda` compatibility package

The native addon moved to `@wrap-esm-lambda/engine-oxc` in 0.4.0. This
package preserves the previous unscoped package name, so existing dependencies
and `require('wrap-esm-lambda')` calls continue to work.

It contains no duplicate native code. Its CommonJS entry point forwards the
complete module object from `@wrap-esm-lambda/engine-oxc`, and its declaration
file re-exports the same TypeScript surface.

New code should depend on and import the scoped package directly:

```sh
npm install @wrap-esm-lambda/engine-oxc
```

```js
const { exportsTap } = require('@wrap-esm-lambda/engine-oxc')
```

Existing code can migrate whenever convenient; keeping the old package name
does not change runtime behavior.
