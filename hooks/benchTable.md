| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 23.1 ± 0.8 | 21.6 | 25.1 | 1.00 | 43.76 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 179.3 ± 3.1 | 172.8 | 184.6 | 7.77 ± 0.31 | 77.57 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 34.4 ± 0.7 | 33.0 | 36.2 | 1.49 ± 0.06 | 56.70 |
| `node --require ./oxc-frida.cjs runtime.mjs` | 26.8 ± 0.9 | 24.8 | 29.8 | 1.16 ± 0.06 | 49.39 |
| `LD_PRELOAD=../wrap-esm-lambda.linux-x64-gnu.node node runtime.mjs` | 25.3 ± 0.9 | 23.6 | 28.9 | 1.10 ± 0.05 | 47.28 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 65.0 ± 1.9 | 62.7 | 71.1 | 2.82 ± 0.13 | 61.71 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 125.0 ± 4.4 | 118.4 | 132.8 | 5.42 ± 0.27 | 366.19 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 44.6 ± 1.3 | 43.0 | 49.5 | 1.93 ± 0.09 | 54.17 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 24.8 ± 1.0 | 22.9 | 28.7 | 1.08 ± 0.06 | 44.17 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 324.8 ± 5.3 | 317.1 | 335.4 | 14.08 ± 0.55 | 117.77 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 208.6 ± 6.1 | 203.0 | 224.2 | 9.04 ± 0.42 | 87.77 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 70.6 ± 1.5 | 68.6 | 73.9 | 3.06 ± 0.13 | 68.75 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 59.1 ± 1.4 | 56.5 | 62.5 | 2.56 ± 0.11 | 59.79 |
