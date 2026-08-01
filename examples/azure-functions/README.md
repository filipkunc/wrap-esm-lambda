# example-azure-functions

An Azure Functions v4 app under Core Tools' `func start` — the real host, the
real Node worker — with every invocation **bracketed from the platform's own
hook pipeline**: this repo's hooks run first and last, and every other agent's
`preInvocation`/`postInvocation` hook is observed, timed, and attributed on
its way past.

The [azure-functions preset](../../packages/hooks/src/azure-functions.mts)
does the work. On Azure there is nothing to patch on disk for this: the hook
registry lives in `@azure/functions-core`, a module the worker serves from a
`require` proxy — it never exists as a file — and the worker executes hooks
strictly in registration order. So the preset registers at the earliest
possible instant (nobody can register before worker setup; the platform
itself guarantees it), patches `registerHook` on the one shared core object
every registration path funnels through, and re-appends its closing hooks to
the tail whenever anyone registers behind them.

[`src/fake-apm.mjs`](src/fake-apm.mjs) plays the coexisting agent, doing what
Application Insights actually does — registering directly against
`@azure/functions-core` — plus a registration through the library's
`app.hook.*`, plus one **late** post hook registered mid-invocation: the case
that would slip behind a bracket held only by registration order.

## Run it

Core Tools is deliberately not a dependency (its postinstall downloads host
binaries, which restricted networks block); install it once:

```sh
npm i -g azure-functions-core-tools@4
```

Then, from this directory — both delivery shapes, asserted end to end:

```sh
pnpm check
```

or by hand, prelude shape (`package.json` `"main"` activates first — Azure's
recommended agent delivery, keeps prewarmed workers usable):

```sh
EXAMPLE_DELIVERY=prelude func start
```

or preload shape (the worker-arguments route, same as the Lambda
`NODE_OPTIONS` story — needed only to get ahead of _other preloaded agents_
or to also tap modules the worker itself loads):

```sh
languageWorkers__node__arguments="--import $(node -e 'console.log(import.meta.resolve("@wrap-esm-lambda/hooks/register"))' --input-type=module)" \
WRAP_ESM_LAMBDA_CONFIG=$PWD/wrap.config.mjs \
func start
```

then:

```sh
curl 'http://localhost:7071/api/hello?name=you'
```

## What you'll see

```
WRAPESM:registration {"hookName":"preInvocation","registrant":"app","frame":"at .../fake-apm.mjs:28:8"}
...
FAKEAPM:pre
FAKEAPM:wrap
FAKEAPM:post
FAKEAPM:post-library
FAKEAPM:post-late
WRAPESM:report {"functionName":"hello","totalMs":33.1,"callbackMs":15.8,"handlerMs":15.4,
  "hookTimings":[{"hookName":"preInvocation","registrant":"app","ms":5.6}, ...],
  "callbackReplaced":true,"handlerBypassed":false, ...}
```

- every fake-agent registration is attributed with a stack frame — including
  the one made through the library's `app.hook.*`, which funnels into the
  same choke point;
- the report prints **after** `FAKEAPM:post-late`: the closing hook stayed
  last even against a mid-invocation registration;
- `handlerMs` (innermost wrap, applied by our _first_ pre hook) excludes the
  fake wrapper's cost; `callbackMs` (outermost wrap, applied by our _last_
  pre hook) includes it; `totalMs` brackets everything including every
  foreign hook body;
- `callbackReplaced` names what the fake agent did to `functionCallback`,
  and `handlerBypassed`/`resultAlteredByPostHooks`/`errorAlteredByPostHooks`
  would name the ruder versions.
