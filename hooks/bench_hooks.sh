# Compile all .ts files in benchmark folder
yarn run compile:bench

# Build swc wasm plugin
cd ../swc-plugin-esm-lambda
rustup target add wasm32-wasip1
cargo build-wasip1 --release
cd ../hooks

# Time measuring
hyperfine --warmup 5 --prepare 'rm -rf .swc/' --export-markdown=benchTable.md \
'node runtime.mjs' \
'node --import ./sync-hooks-babel.mjs runtime.mjs' \
'node --import ./sync-hooks-oxc.mjs runtime.mjs' \
'node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs' \
'node --import ./sync-hooks-swc.mjs runtime.mjs' \
'node --import ./sync-hooks-acorn.mjs runtime.mjs' \
'node --import ./sync-hooks-regex.mjs runtime.mjs' \
'node --import ./async-hooks-babel-one-file.mjs runtime.mjs' \
'node --import ./register-async-hooks-babel.mjs runtime.mjs' \
'node --import ./register-async-hooks-oxc.mjs runtime.mjs' \
'node --import ./register-async-hooks-regex.mjs runtime.mjs'

./bench_max_rss.sh
