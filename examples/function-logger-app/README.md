# example-function-logger-app

The consumer side of [example-function-logger](../function-logger): an
ordinary app whose whole instrumentation integration is one installed
package plus one `--import` flag — no config file, no patch code, nothing
instrumentation-aware in the app itself.

```sh
pnpm --filter example-function-logger-app start             # node --import example-function-logger/register app.mjs
pnpm --filter example-function-logger-app start:env-config  # WRAP_ESM_LAMBDA_CONFIG=example-function-logger/config + the generic register entry
```

Both produce identical output — see the
[function-logger README](../function-logger/README.md) for the expected
transcript and the build-time variant.
