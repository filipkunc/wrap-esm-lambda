// Config for the dependency footgun fixture: the patch imports the very
// package it instruments. See imports-target.ts.
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'

export default definePatches([
  {
    module: {
      name: '@fake/smithy-client',
      versionRange: '>=4 <5',
      files: ['dist-es/client.js', 'dist-cjs/index.js'],
    },
    patch: {
      name: 'patchImportsTarget',
      from: fileURLToPath(new URL('./patches/imports-target.ts', import.meta.url)),
    },
    bindings: ['Client'],
  },
])
