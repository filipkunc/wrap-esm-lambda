| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 24.8 ± 1.6 | 22.2 | 31.7 | 1.00 | 48.68 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 170.8 ± 1.3 | 167.9 | 172.5 | 6.90 ± 0.44 | 86.60 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 26.7 ± 1.1 | 24.5 | 30.4 | 1.08 ± 0.08 | 50.77 |
| `node --require ./oxc-frida.cjs runtime.mjs` | 26.8 ± 1.1 | 24.7 | 31.2 | 1.08 ± 0.08 | 51.52 |
| `LD_PRELOAD=../wrap-esm-lambda.linux-x64-gnu.node node runtime.mjs` | 26.5 ± 1.3 | 24.3 | 30.5 | 1.07 ± 0.09 | 51.56 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 67.2 ± 2.1 | 63.8 | 71.6 | 2.71 ± 0.19 | 63.26 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 115.6 ± 2.1 | 113.0 | 120.9 | 4.67 ± 0.31 | 178.72 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 42.6 ± 2.2 | 39.0 | 48.0 | 1.72 ± 0.14 | 52.48 |
| `node --import ./sync-hooks-orchestrion.mjs runtime.mjs` | 51.5 ± 1.8 | 47.6 | 56.0 | 2.08 ± 0.15 | 53.94 |
| `node --import ./sync-hooks-orchestrion-tracing.mjs runtime.mjs` | 59.5 ± 2.3 | 55.3 | 66.3 | 2.40 ± 0.18 | 55.47 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 25.2 ± 1.2 | 23.3 | 29.7 | 1.02 ± 0.08 | 48.73 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 317.8 ± 2.6 | 314.4 | 322.0 | 12.83 ± 0.82 | 128.30 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 203.4 ± 2.6 | 199.4 | 207.7 | 8.21 ± 0.53 | 99.60 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 63.0 ± 1.3 | 61.4 | 66.9 | 2.55 ± 0.17 | 66.36 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 61.8 ± 1.7 | 59.2 | 67.9 | 2.49 ± 0.17 | 64.29 |
