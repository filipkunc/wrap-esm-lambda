// The corpus: popular packages curated by ARTIFACT SHAPE, not download rank.
// Raw top-N lists cluster by build tool (mostly redundant rollup/tsup
// output), so each entry here has to claim a shape the table does not
// already cover — that is the admission rule, and it is why the corpus can
// stay small enough to run on every push. Groups are documentation, not
// mechanism; every package runs the same battery (see run.mjs).
//
// Per-entry knobs:
//   name          npm package name (must be a dependency of corpus/package.json)
//   group         which shape family the entry represents (table column)
//   build         false skips the esbuild parity + hybrid cells, with `notes` saying why
//   buildExternal esbuild externals for optional deps the package requires lazily
//   probe         true runs probes/<key>.mjs under probes/<key>.config.mjs (key = name
//                 with '@'/'/' cleaned), the behavioral micro-probe cell
//   expect        per-cell expected outcome overrides; the default expectation is
//                 import/require/build PATCHED, hybrid GUARDED, probe OK. A deviation
//                 from expectation fails the run — known-and-documented outcomes are
//                 encoded here so the matrix distinguishes "finding" from "regression".
//   notes         one-liner surfaced in matrix.md

/** The battery cells whose outcomes the manifest can override. */
export type CellName = 'import' | 'require' | 'build' | 'hybrid' | 'probe'

export interface CorpusEntry {
  /** npm package name (must be a dependency of corpus/package.json) */
  name: string
  /** which shape family the entry represents (table column) */
  group: 'handwritten-cjs' | 'transpiled-cjs' | 'dual' | 'esm' | 'instrumentation'
  /** one-liner surfaced in matrix.md */
  notes: string
  /** run probes/<key>.mts under probes/<key>.config.mts */
  probe?: boolean
  /** false skips the esbuild parity + hybrid cells; `notes` says why */
  build?: false
  /** esbuild externals for optional deps the package requires lazily */
  buildExternal?: string[]
  /** 'require' restricts the tap to the require-condition entry (vue) */
  targets?: 'require'
  /** named bindings to drop, for transform gaps a package exposes */
  excludeBindings?: string[]
  /** per-cell expected-outcome overrides (finding vs regression) */
  expect?: Partial<Record<CellName, string>>
}

export const packages: CorpusEntry[] = [
  // ── handwritten CJS — the shapes Module._load tools grew up on ─────────────
  {
    name: 'lodash',
    group: 'handwritten-cjs',
    notes: 'monolithic single-file CJS, ~640 properties on one exports object',
  },
  {
    name: 'debug',
    group: 'handwritten-cjs',
    notes: 'module.exports is a function with properties hung off it',
  },
  { name: 'ms', group: 'handwritten-cjs', notes: 'bare module.exports = function — the "module.exports" binding' },
  { name: 'semver', group: 'handwritten-cjs', notes: 'function+classes exports object, ubiquitous transitive dep' },
  {
    name: 'pg',
    group: 'handwritten-cjs',
    probe: true,
    buildExternal: ['pg-native'],
    notes: 'handwritten CJS with a lazy getter (exports.native requires pg-native on read)',
  },
  {
    name: 'react',
    group: 'handwritten-cjs',
    notes: 'entry picks cjs/react.production.js vs development at require time',
  },
  {
    name: 'graceful-fs',
    group: 'handwritten-cjs',
    notes: 'monkey-patches fs itself — another patcher already in the room',
  },

  // ── transpiled / machine-generated CJS ─────────────────────────────────────
  {
    name: 'ioredis',
    group: 'transpiled-cjs',
    probe: true,
    notes: 'tsc output with the exports.default + __esModule interop dance',
  },
  {
    name: 'mongodb',
    group: 'transpiled-cjs',
    probe: true,
    buildExternal: [
      'kerberos',
      '@mongodb-js/zstd',
      'snappy',
      'mongodb-client-encryption',
      '@aws-sdk/credential-providers',
      'gcp-metadata',
      'socks',
      'aws4',
    ],
    notes: 'large tsc-compiled class-heavy driver',
  },
  {
    name: 'typescript',
    group: 'transpiled-cjs',
    build: false,
    notes: 'the perf stress row — one enormous CJS file; transform time tracked in the table',
  },

  // ── dual packages and exports maps ─────────────────────────────────────────
  { name: 'zod', group: 'dual', notes: 'bundled dual, one big entry per tree' },
  {
    name: 'axios',
    group: 'dual',
    notes: 'dual with default-export-centric interop (self-referencing aliases)',
  },
  {
    name: 'date-fns',
    group: 'dual',
    // CORPUS FINDING, FIXED: `longFormatters` reaches the barrel through two
    // `export *` sources (./format.js, ./parse.js) that forward the SAME
    // origin binding. The star walk used to refuse it by provider count;
    // it now compares transitive origins the way ResolveExport does (see
    // core/src/stars.mts and __test__/stars-dedup.spec.ts), so the full
    // surface taps. The excludeBindings knob this finding introduced stays
    // available for future gaps.
    notes: 'per-function dual behind a huge exports map; longFormatters exercises same-binding star dedup',
  },
  {
    name: 'vue',
    group: 'dual',
    // CORPUS FINDING: vue's import condition is one line — `export * from
    // './index.js'` where index.js is CJS. A star into CJS is statically
    // invisible (documented loud limit), so the tap targets the CJS
    // defining entry instead; both consumer routes observe the patch
    // because the ESM wrapper loads that entry underneath.
    targets: 'require',
    notes: 'ESM condition is `export *` from a CJS file — tapped at the CJS defining entry',
  },
  { name: 'uuid', group: 'dual', notes: 'small dual with browser conditions' },
  { name: 'nanoid', group: 'dual', notes: 'small dual, minimal surface' },
  {
    name: 'graphql',
    group: 'dual',
    probe: true,
    notes: 'per-module dual (.js + .mjs side by side), deep internal re-export chains',
  },

  // ── ESM-only and barrel-heavy — the rewrite path's home turf ───────────────
  {
    name: 'lodash-es',
    group: 'esm',
    notes: '~640 re-exports from one barrel — list re-export splitting at volume',
  },
  { name: 'rxjs', group: 'esm', notes: 'deep re-export chains behind the barrel' },
  { name: 'chalk', group: 'esm', notes: 'pure ESM, no CJS escape hatch' },
  { name: 'execa', group: 'esm', notes: 'pure ESM, class-field-heavy internals' },
  { name: 'p-limit', group: 'esm', notes: 'pure ESM micro-package, default export' },

  // ── instrumentation-realistic targets — who patches get written for ────────
  {
    name: 'undici',
    group: 'instrumentation',
    probe: true,
    notes: 'the fetch/http client under Node itself',
  },
  { name: 'mysql2', group: 'instrumentation', probe: true, notes: 'callback+promise dual API driver' },
  { name: 'redis', group: 'instrumentation', probe: true, notes: 'node-redis, a monorepo of packages' },
  { name: 'koa', group: 'instrumentation', probe: true, notes: 'module.exports is the Application class' },
  {
    name: 'knex',
    group: 'instrumentation',
    probe: true,
    buildExternal: [
      'better-sqlite3',
      'sqlite3',
      'mysql',
      'mariadb',
      'oracledb',
      'pg-query-stream',
      'tedious',
      'pg-native',
    ],
    notes: 'query builder over dialect drivers required lazily',
  },
  {
    name: '@nestjs/core',
    group: 'instrumentation',
    probe: true,
    build: false,
    notes: 'probe patches express UNDERNEATH Nest (patch-through); optional-peer graph is not esbuild-bundleable',
  },
]

/** probes/<key>.mts + probes/<key>.config.mts + patches/<key>.mts naming */
export function keyFor(name: string): string {
  return name.replaceAll('@', '').replaceAll('/', '-')
}

/*
 * Deliberate exclusions, so absence reads as a decision instead of an
 * oversight:
 * - express / fastify / hono / @smithy-core — already pinned one-per-shape by
 *   __test__/frameworks.spec.ts and __test__/aws.spec.ts (docs/real-packages.md).
 * - next / @angular/* — platforms that own their module graph, exercised as
 *   HOSTS for the runtime hook (instrumentation.ts, NODE_OPTIONS), not as tap
 *   targets; see docs/real-packages.md.
 * - googleapis / aws-sdk v2 — the lazy-getter-at-scale shape, excluded for
 *   install weight (~100MB each in every workspace install); pg covers getter
 *   safety, lodash covers surface scale.
 * - sharp / bcrypt — native addons, nothing for a source tap to reach.
 * - @prisma/client — generated code needs a codegen step; add once the corpus
 *   is cheap to extend.
 */
