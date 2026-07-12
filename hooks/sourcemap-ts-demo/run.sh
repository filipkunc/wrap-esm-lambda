#!/usr/bin/env bash
# Shows source maps chaining all the way back to TypeScript.
#
# handler.ts --(tsc)--> handler.js + handler.js.map --(our wrap)--> transformed
#
# The handler throws on line 15 of handler.ts. tsc strips the types (throw moves
# to line 4 of handler.js) and our wrap shifts it again. Only a map that chains
# transformed -> handler.js -> handler.ts points the exception back at the .ts.
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
