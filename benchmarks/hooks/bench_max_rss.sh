# Max resident set size — median of 5 runs per command. Peak RSS of a V8
# process swings a few MB run to run, so a single sample encodes noise into
# the table: it once showed a ~4 MB oxc-vs-acorn gap where the stable
# difference is the ~2 MB dlopen of the native addon.

median_time() {
  out=$1
  shift
  for i in 1 2 3 4 5; do
    /usr/bin/time -v -o "$out.run$i" "$@"
  done
  keep=$(grep -H 'Maximum resident set size' "$out".run* | sort -t: -k3 -n | sed -n 3p | cut -d: -f1)
  mv "$keep" "$out"
  rm -f "$out".run*
}

median_time time_baseline.txt node runtime.mjs
median_time time_sync_noop.txt node --import ./sync-hooks-noop.mjs runtime.mjs
median_time time_register_tap_oxc.txt node --import ./register-tap-oxc.mjs runtime.mjs
median_time time_register_tap_acorn.txt node --import ./register-tap-acorn.mjs runtime.mjs
median_time time_sync_orchestrion.txt node --import ./sync-hooks-orchestrion.mjs runtime.mjs
median_time time_sync_orchestrion_tracing.txt node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs

node update-bench-table.mjs
node make-chart.mjs

rm -rf time_*.txt
