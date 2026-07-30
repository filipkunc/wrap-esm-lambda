# Cold start by delivery — the same app, the same patches

Measured through the real AWS Lambda runtime interface emulator
(`aws-lambda-rie`, linux/amd64 host) answering the example's `get-quote`
event against `app.handler`: five fresh boots per delivery, `Billed
Duration` of the first REPORT line, median reported; RSS is the
invocation-metrics patch's own in-process line. The runtime hook ran the
acorn engine. The CI Lambda lane reproduces the same contrast per runtime
image and architecture on every push — the job summary carries those live
numbers; this table pins one measured set for the chart.

| delivery                                   | cold start, billed (median) | in-process RSS (median) |
| ------------------------------------------ | --------------------------- | ----------------------- |
| `runtime hook (NODE_OPTIONS + config)`     | 269 ms                      | 91 MB                   |
| `esbuild bundle (unplugin, patches baked)` | 166 ms                      | 68 MB                   |

Raw billed samples: hook 666, 262, 331, 269, 266 ms (the first boot pays
the host's page-cache warmup — the median absorbs it); bundle 141, 178,
166, 158, 174 ms.

Regenerate the chart after re-measuring: `node make-chart.mjs` in this
directory (renders `coldStartChart.svg` from this table).
