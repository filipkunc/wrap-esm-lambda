yarn run compile:bench

hyperfine --warmup 3 --export-markdown=benchTable.md \
'node runtime.mjs' \
'node --import ./sync-hooks-babel.mjs runtime.mjs' \
'node --import ./sync-hooks-oxc.mjs runtime.mjs'
