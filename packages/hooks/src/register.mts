// `--import` entry: loads the config module named by WRAP_ESM_LAMBDA_CONFIG
// (default export of a `defineConfig(...)` file) and registers the load hook.
// The value is a file path — or a bare package specifier, so an installed
// instrumentation package needs no config file in the app at all:
//
//   WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs node --import @wrap-esm-lambda/hooks/register app.mjs
//   WRAP_ESM_LAMBDA_CONFIG=@acme/apm/config  node --import @wrap-esm-lambda/hooks/register app.mjs
//
// WRAP_ESM_LAMBDA_DISABLE=1 short-circuits the entry before anything is
// resolved or loaded — one env var takes instrumentation out of a deployment
// whose start command cannot change (and whose config may be the thing at
// fault). Core's engine binding is behind the dynamic import below precisely
// so that switch also skips the addon's dlopen: disabled means no work, not
// less work.
//
// Config resolution itself stays LOUD. Unlike a drifted binding or a patch
// module that will not import, a config that cannot be found has nothing to
// degrade to, and an operator who passed the flag should learn at startup that
// they got no instrumentation — not from absent telemetry hours later. The
// disable switch is the deliberate way to say "not now".
// the diagnostics subpath, not core's index: reading one env var must not pull
// in the transform engine
import { isDisabled, debug } from '@wrap-esm-lambda/core/diagnostics'

if (isDisabled()) {
  debug('disabled by WRAP_ESM_LAMBDA_DISABLE — config not loaded, engine not bound')
} else {
  const configPath = process.env.WRAP_ESM_LAMBDA_CONFIG
  if (!configPath) {
    throw new Error(
      '@wrap-esm-lambda/hooks/register: set WRAP_ESM_LAMBDA_CONFIG to your config file path or package specifier',
    )
  }

  // Resolution rule lives in core (locate.mts) and is shared with
  // `wrap-esm-lambda-validate`: a config that resolves for the validator but
  // not for this entry — or the reverse — would be the worst kind of trap.
  const { resolveConfigUrl } = await import('@wrap-esm-lambda/core')
  const configUrl = resolveConfigUrl(
    configPath,
    `@wrap-esm-lambda/hooks/register: WRAP_ESM_LAMBDA_CONFIG`,
    process.cwd(),
  )
  const { default: config } = await import(configUrl)
  const { registerConfig } = await import('./index.mjs')
  await registerConfig(config)
}
