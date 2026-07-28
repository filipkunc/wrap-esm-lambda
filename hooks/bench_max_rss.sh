# Max resident set size
/usr/bin/time -v -o time_baseline.txt node runtime.mjs
/usr/bin/time -v -o time_sync_noop.txt node --import ./sync-hooks-noop.mjs runtime.mjs
/usr/bin/time -v -o time_register_tap_oxc.txt node --import ./register-tap-oxc.mjs runtime.mjs
/usr/bin/time -v -o time_register_tap_acorn.txt node --import ./register-tap-acorn.mjs runtime.mjs
/usr/bin/time -v -o time_sync_orchestrion.txt node --import ./sync-hooks-orchestrion.mjs runtime.mjs
/usr/bin/time -v -o time_sync_orchestrion_tracing.txt node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs

node update-bench-table.mjs
node make-chart.mjs

rm -rf time_*.txt
