| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 24.1 ± 0.8 | 21.8 | 27.5 | 1.00 | 43.61 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 177.6 ± 2.7 | 174.5 | 184.3 | 7.37 ± 0.28 | 77.11 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 35.9 ± 0.8 | 34.4 | 37.3 | 1.49 ± 0.06 | 54.68 |
| `node --import ./sync-hooks-oxc-frida.mjs runtime.mjs` | 36.3 ± 1.0 | 33.7 | 38.7 | 1.50 ± 0.07 | 58.49 |
| `LD_PRELOAD=../wrap-esm-lambda.linux-x64-gnu.node node runtime.mjs` | 24.9 ± 0.7 | 23.7 | 26.6 | 1.04 ± 0.05 | 47.29 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 67.0 ± 2.4 | 63.8 | 77.1 | 2.78 ± 0.14 | 60.94 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 129.5 ± 5.1 | 119.5 | 140.8 | 5.37 ± 0.28 | 368.23 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 44.8 ± 0.8 | 43.3 | 47.0 | 1.86 ± 0.07 | 53.93 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 24.5 ± 0.9 | 22.8 | 30.8 | 1.02 ± 0.05 | 46.00 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 340.6 ± 11.7 | 328.3 | 360.2 | 14.13 ± 0.70 | 114.49 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 214.6 ± 6.2 | 206.6 | 225.3 | 8.91 ± 0.41 | 90.12 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 75.3 ± 1.3 | 72.8 | 79.2 | 3.13 ± 0.12 | 68.45 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 57.7 ± 1.2 | 56.1 | 61.5 | 2.40 ± 0.10 | 59.43 |
