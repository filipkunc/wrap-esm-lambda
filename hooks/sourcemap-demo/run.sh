#!/usr/bin/env bash
# Shows how oxc's native source maps fix exception stack traces.
#
# The handler throws on line 11 of handler-throws.mjs, but codegen strips the
# blank lines above it, so the throw lands on line 4 of the transformed source
# Node actually compiles. Without a source map the stack points at line 4 (the
# wrong line, a comment in the original); with the oxc-generated inline map it
# points back at line 11.
set -euo pipefail
cd "$(dirname "$0")"

echo "Original throw location:"
grep -n 'throw new Error' handler-throws.mjs
echo

echo "=== WITHOUT source map (plain transformLambda) ==="
node --enable-source-maps --import ./sync-hooks-oxc-nomap.mjs runtime-throws.mjs 2>&1 | head -2
echo

echo "=== WITH oxc source map (transformLambdaWithMap) ==="
node --enable-source-maps --import ./sync-hooks-oxc-sourcemap.mjs runtime-throws.mjs 2>&1 | head -2
