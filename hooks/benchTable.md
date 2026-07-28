| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 39.8 ± 3.4 | 33.0 | 55.8 | 1.00 | 44.96 |
| `node --import ./sync-hooks-noop.mjs runtime.mjs` | 40.4 ± 3.1 | 35.5 | 57.5 | 1.01 ± 0.12 | 45.13 |
| `node --import ./register-tap-oxc.mjs runtime.mjs` | 74.2 ± 5.5 | 67.2 | 88.7 | 1.86 ± 0.21 | 60.94 |
| `node --import ./register-tap-acorn.mjs runtime.mjs` | 83.1 ± 9.8 | 73.0 | 116.8 | 2.09 ± 0.30 | 57.15 |
| `node --import ./sync-hooks-orchestrion.mjs runtime.mjs` | 76.6 ± 4.4 | 69.4 | 88.5 | 1.92 ± 0.20 | 56.17 |
| `node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs` | 87.4 ± 5.6 | 77.6 | 97.8 | 2.19 ± 0.23 | 57.05 |
