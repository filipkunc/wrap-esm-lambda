# Cold start of the tap's runtime shell against its mechanism neighbors:
# baseline process, a no-op registerHooks floor, the real register entry on
# both engines (one path-matched entry wrapping handler.mjs), and
# orchestrion's registerHooks transforms on the same file.

# The register entries load the compiled workspace packages
pnpm run build:packages

# Time measuring
hyperfine --warmup 5 --export-markdown=benchTable.md \
'node runtime.mjs' \
'node --import ./sync-hooks-noop.mjs runtime.mjs' \
'node --import ./register-tap-oxc.mjs runtime.mjs' \
'node --import ./register-tap-acorn.mjs runtime.mjs' \
'node --import ./sync-hooks-orchestrion.mjs runtime.mjs' \
'node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs'

./bench_max_rss.sh
