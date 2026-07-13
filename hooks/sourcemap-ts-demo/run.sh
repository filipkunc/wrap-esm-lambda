#!/usr/bin/env bash
# Shows source maps chaining all the way back to TypeScript, and the faster
# alternative: skip tsc and let oxc parse + strip the .ts directly.
#
# tsc path:    handler.ts --(tsc)--> handler.js + handler.js.map --(our wrap)--> transformed
# native path: handler.ts ------------------(our wrap, oxc parses .ts)-------------> transformed
#
# The handler throws on line 15 of handler.ts. tsc strips the types (throw moves
# to line 4 of handler.js) and our wrap shifts it again. Only a map that chains
# transformed -> handler.js -> handler.ts points the exception back at the .ts,
# unless oxc parses the .ts itself, in which case there is nothing to chain.
set -euo pipefail
cd "$(dirname "$0")"

echo "Compiling handler.ts -> handler.js (+ handler.js.map) ..."
../../node_modules/.bin/tsc handler.ts --target esnext --module esnext \
  --moduleResolution bundler --sourceMap --inlineSources --skipLibCheck

echo "TS throw location:"
grep -n 'throw new Error' handler.ts
echo

echo "=== wrap with NON-chained map (transformed -> handler.js only) ==="
node --enable-source-maps --import ./sync-hooks-oxc-ts-nochain.mjs runtime-throws.mjs 2>&1 | grep -E "Error|handler\." | head -2
echo

echo "=== wrap with CHAINED map (transformed -> handler.js -> handler.ts) ==="
node --enable-source-maps --import ./sync-hooks-oxc-ts.mjs runtime-throws.mjs 2>&1 | grep -E "Error|handler\." | head -2
echo

echo "=== wrap with NATIVE .ts map (oxc parses handler.ts directly, no tsc) ==="
node --enable-source-maps --import ./sync-hooks-oxc-ts-native.mjs runtime-throws-native.mjs 2>&1 | grep -E "Error|handler\." | head -2
