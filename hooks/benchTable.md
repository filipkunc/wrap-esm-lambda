| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 25.2 ± 1.4 | 22.7 | 29.9 | 1.00 | 48.65 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 175.3 ± 3.2 | 170.4 | 181.5 | 6.95 ± 0.41 | 85.35 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 27.8 ± 1.8 | 25.4 | 33.5 | 1.10 ± 0.09 | 50.45 |
| `node --require ./oxc-frida.cjs runtime.mjs` | 27.7 ± 1.7 | 23.9 | 32.2 | 1.10 ± 0.09 | 49.36 |
| `LD_PRELOAD=../wrap-esm-lambda.linux-x64-gnu.node node runtime.mjs` | 27.2 ± 2.0 | 23.9 | 34.8 | 1.08 ± 0.10 | 48.97 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 74.7 ± 2.2 | 70.3 | 81.2 | 2.96 ± 0.19 | 63.06 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 125.3 ± 3.1 | 120.6 | 134.3 | 4.97 ± 0.30 | 179.95 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 46.9 ± 2.8 | 41.1 | 55.2 | 1.86 ± 0.15 | 52.30 |
| `node --import ./sync-hooks-orchestrion.mjs runtime.mjs` | 57.4 ± 2.6 | 53.0 | 63.5 | 2.27 ± 0.16 | 54.03 |
| `node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs` | 63.1 ± 2.9 | 56.6 | 69.3 | 2.50 ± 0.18 | 55.55 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 26.7 ± 1.6 | 24.1 | 31.9 | 1.06 ± 0.09 | 48.87 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 343.2 ± 6.5 | 327.8 | 350.3 | 13.61 ± 0.80 | 129.47 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 219.9 ± 4.1 | 210.3 | 226.5 | 8.72 ± 0.51 | 98.96 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 69.5 ± 1.8 | 65.6 | 74.1 | 2.76 ± 0.17 | 65.09 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 67.4 ± 2.4 | 62.6 | 73.8 | 2.67 ± 0.18 | 64.19 |
