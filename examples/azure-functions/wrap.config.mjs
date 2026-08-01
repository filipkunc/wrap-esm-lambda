// Evaluated at preload by `--import @wrap-esm-lambda/hooks/register`
// (delivered through the languageWorkers__node__arguments app setting). The
// preset emits no patch entries — the bracket rides the platform's hook
// pipeline — so the runtime shell registers no transform hook and never
// binds the engine; the preset arms its own activation poll instead.
import { definePatches } from '@wrap-esm-lambda/core'
import { azureFunctionsEntries } from '@wrap-esm-lambda/hooks/azure-functions'
import { reportOptions } from './src/report.mjs'

export default definePatches([...azureFunctionsEntries(reportOptions)], import.meta.url)
