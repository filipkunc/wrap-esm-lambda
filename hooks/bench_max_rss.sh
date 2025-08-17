# Max resident set size
rm -rf .swc/
/usr/bin/time -v -o time_baseline.txt node runtime.mjs
/usr/bin/time -v -o time_sync_babel.txt node --import ./sync-hooks-babel.mjs runtime.mjs
/usr/bin/time -v -o time_sync_oxc.txt node --import ./sync-hooks-oxc.mjs runtime.mjs
/usr/bin/time -v -o time_sync_oxc_frida.txt node --import ./sync-hooks-oxc-frida.mjs runtime.mjs
/usr/bin/time -v -o time_sync_oxc_preload.txt sh -c "LD_PRELOAD=../wrap-esm-lambda.linux-x64-gnu.node node runtime.mjs"
/usr/bin/time -v -o time_sync_oxc_wasm.txt node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs
/usr/bin/time -v -o time_sync_swc.txt node --import ./sync-hooks-swc.mjs runtime.mjs
/usr/bin/time -v -o time_sync_acorn.txt node --import ./sync-hooks-acorn.mjs runtime.mjs
/usr/bin/time -v -o time_sync_regex.txt node --import ./sync-hooks-regex.mjs runtime.mjs
/usr/bin/time -v -o time_async_babel_one_file.txt node --import ./async-hooks-babel-one-file.mjs runtime.mjs
/usr/bin/time -v -o time_async_babel.txt node --import ./register-async-hooks-babel.mjs runtime.mjs
/usr/bin/time -v -o time_async_oxc.txt node --import ./register-async-hooks-oxc.mjs runtime.mjs
/usr/bin/time -v -o time_async_regex.txt node --import ./register-async-hooks-regex.mjs runtime.mjs

node update-bench-table.mjs

rm -rf time_*.txt
