| Command | Mean [ms] | Min [ms] | Max [ms] | Relative | Max RSS [MB] |
|:---|---:|---:|---:|---:|---:|
| `node runtime.mjs` | 24.7 ± 1.2 | 22.3 | 33.6 | 1.00 | 43.77 |
| `node --import ./sync-hooks-babel.mjs runtime.mjs` | 190.6 ± 3.1 | 185.6 | 195.7 | 7.73 ± 0.40 | 78.73 |
| `node --import ./sync-hooks-oxc.mjs runtime.mjs` | 36.3 ± 0.9 | 34.9 | 40.9 | 1.47 ± 0.08 | 56.86 |
| `node --import ./sync-hooks-oxc-frida.mjs runtime.mjs` | 36.4 ± 0.8 | 34.4 | 38.2 | 1.48 ± 0.08 | 58.66 |
| `LD_PRELOAD=../wrap-esm-lambda.linux-x64-gnu.node node runtime.mjs` | 27.6 ± 1.2 | 25.8 | 32.7 | 1.12 ± 0.07 | 47.32 |
| `node --import ./sync-hooks-oxc-wasm.mjs runtime.mjs` | 67.4 ± 1.6 | 65.0 | 73.2 | 2.73 ± 0.15 | 60.95 |
| `node --import ./sync-hooks-swc.mjs runtime.mjs` | 130.3 ± 10.2 | 121.7 | 171.3 | 5.28 ± 0.49 | 378.23 |
| `node --import ./sync-hooks-acorn.mjs runtime.mjs` | 50.3 ± 1.4 | 48.0 | 55.3 | 2.04 ± 0.11 | 54.13 |
| `node --import ./sync-hooks-regex.mjs runtime.mjs` | 25.6 ± 0.7 | 24.3 | 28.0 | 1.04 ± 0.06 | 46.18 |
| `node --import ./async-hooks-babel-one-file.mjs runtime.mjs` | 353.4 ± 9.5 | 334.6 | 366.4 | 14.33 ± 0.80 | 114.36 |
| `node --import ./register-async-hooks-babel.mjs runtime.mjs` | 214.3 ± 5.0 | 207.6 | 224.7 | 8.69 ± 0.47 | 90.50 |
| `node --import ./register-async-hooks-oxc.mjs runtime.mjs` | 74.6 ± 3.0 | 72.1 | 85.2 | 3.03 ± 0.19 | 66.13 |
| `node --import ./register-async-hooks-regex.mjs runtime.mjs` | 62.2 ± 1.7 | 58.3 | 67.0 | 2.52 ± 0.14 | 57.80 |
