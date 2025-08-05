yarn run compile:bench

cd ../swc-plugin-esm-lambda
cargo build-wasip1 --release
cd ../hooks

rm -r .swc/

hyperfine --warmup 5 --export-markdown=benchTable.md \
'node runtime.mjs' \
'node --import ./sync-hooks-babel.mjs runtime.mjs' \
'node --import ./sync-hooks-oxc.mjs runtime.mjs' \
'node --import ./sync-hooks-swc.mjs runtime.mjs' \
'node --import ./sync-hooks-replace.mjs runtime.mjs' \
'node --import ./async-hooks-babel-one-file.mjs runtime.mjs' \
'node --import ./register-async-hooks-babel.mjs runtime.mjs' \
'node --import ./register-async-hooks-oxc.mjs runtime.mjs' \
'node --import ./register-async-hooks-replace.mjs runtime.mjs'
