| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 36.7 ± 2.7 | 32.3 | 45.0 | 1.00 | 44.99 |
| `node --import ./sync-hooks-noop.mjs runtime.mjs` | 37.0 ± 2.0 | 33.5 | 45.3 | 1.01 ± 0.09 | 45.09 |
| `node --import ./register-tap-oxc.mjs runtime.mjs` | 73.5 ± 5.0 | 65.1 | 89.2 | 2.00 ± 0.20 | 60.63 |
| `node --import ./register-tap-acorn.mjs runtime.mjs` | 79.0 ± 4.1 | 71.6 | 94.2 | 2.15 ± 0.19 | 57.09 |
| `node --import ./sync-hooks-orchestrion.mjs runtime.mjs` | 69.2 ± 3.0 | 65.2 | 80.2 | 1.89 ± 0.16 | 56.16 |
| `node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs` | 80.2 ± 5.4 | 72.5 | 95.0 | 2.19 ± 0.22 | 57.01 |
