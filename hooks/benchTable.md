| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 36.7 ± 3.6 | 32.1 | 51.2 | 1.00 | 44.98 |
| `node --import ./sync-hooks-noop.mjs runtime.mjs` | 36.9 ± 1.9 | 33.2 | 44.8 | 1.00 ± 0.11 | 45.09 |
| `node --import ./register-tap-oxc.mjs runtime.mjs` | 57.7 ± 2.8 | 51.8 | 68.5 | 1.57 ± 0.17 | 56.68 |
| `node --import ./register-tap-acorn.mjs runtime.mjs` | 77.3 ± 4.0 | 71.6 | 88.2 | 2.11 ± 0.23 | 57.03 |
| `node --import ./sync-hooks-orchestrion.mjs runtime.mjs` | 69.5 ± 3.5 | 64.5 | 79.7 | 1.89 ± 0.21 | 56.16 |
| `node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs` | 79.2 ± 6.1 | 73.1 | 101.2 | 2.16 ± 0.27 | 57.00 |
