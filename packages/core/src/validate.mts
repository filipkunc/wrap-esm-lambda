// Config validation: does this config still describe the packages actually
// installed here?
//
// This is the other half of the runtime shell's fail-soft policy. Degrading
// quietly is right at 3am — losing a patch beats an outage — but it moves the
// cost to whoever notices the telemetry is thin. So the same questions the tap
// asks at load time (is the package here, does the version satisfy the range,
// does the module still export these names) get asked here, ahead of time,
// against the installed tree: in CI, in a pre-deploy check, wherever failing
// is cheap.
//
// What can be checked statically is exactly what the tap checks statically —
// no more. An ESM module's exports are visible in its source, so a drifted
// binding is caught. A CJS module's are not (they are assembled at runtime,
// which is why the CJS tap validates nothing and reaches through
// `module.exports` instead), so those entries report as unverifiable rather
// than as passing.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isBuiltin } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { esmModuleExports, resolveModule } from './engine.mjs'
import { moduleKindFor } from './format.mjs'
import { nearestPackage } from './match.mjs'
import { satisfies } from './range.mjs'
import { resolveStarBindings } from './stars.mjs'
import type { InstrumentConfig, InstrumentEntry, PatchEntry } from './config.mjs'

/**
 * - `ok` — checked, and it holds.
 * - `skipped` — deliberately not active or not statically checkable (a version
 *   gate that excludes this environment, a CJS target, a path-matched wrap
 *   entry). Not a problem, but not a guarantee either.
 * - `error` — the config asks for something this tree cannot deliver.
 */
export type CheckStatus = 'ok' | 'skipped' | 'error'

export interface EntryReport {
  /** Human-readable identification of the entry, for output. */
  label: string
  status: CheckStatus
  /** What was found — the reason, in one line. */
  detail: string
}

export interface ValidationReport {
  entries: EntryReport[]
  ok: boolean
  counts: Record<CheckStatus, number>
}

/** Where an installed package lives, and which version it is. */
function locatePackage(name: string, cwd: string): { root: string; version: string } | null {
  const fromDir = cwd
  const entryFile = resolveModule(name, fromDir)
  if (entryFile !== null) {
    const pkg = nearestPackage(entryFile)
    if (pkg) return { root: pkg.root, version: pkg.version }
  }
  // a package whose "exports" map has no root entry still has a package.json,
  // and its files can still be matched at load time
  try {
    const manifest = createRequire(join(cwd, 'noop.js')).resolve(`${name}/package.json`)
    const pkg = nearestPackage(manifest)
    if (pkg) return { root: pkg.root, version: pkg.version }
  } catch {
    // not installed
  }
  return null
}

/** Which requested bindings a module's own source cannot account for. */
function missingBindings(source: string, bindings: string[], filePath: string): string[] {
  const { names, starSources } = esmModuleExports(source)
  const known = new Set(names)
  const missing = bindings.filter((name) => !known.has(name))
  if (missing.length === 0 || starSources.length === 0) return missing
  // the tap resolves star-forwarded names by walking the star sources; a name
  // one of them provides is not missing
  let resolved: { binding: string }[] = []
  try {
    resolved = resolveStarBindings(missing, starSources, filePath)
  } catch {
    // an ambiguous name is a real error the tap would raise; leave it missing
  }
  const found = new Set(resolved.map((r) => r.binding))
  return missing.filter((name) => !found.has(name))
}

/** Check one file of a matched package against the entry's bindings. */
function checkFile(filePath: string, bindings: string[]): { status: CheckStatus; detail: string } {
  if (!existsSync(filePath)) {
    return { status: 'error', detail: `declared file is not in the installed package: ${filePath}` }
  }
  const source = readFileSync(filePath, 'utf8')
  if (moduleKindFor(filePath, undefined, () => source) === 'cjs') {
    return {
      status: 'skipped',
      detail: 'CommonJS: exports are assembled at runtime, so bindings cannot be checked ahead of time',
    }
  }
  const missing = missingBindings(source, bindings, filePath)
  if (missing.length > 0) {
    const { names } = esmModuleExports(source)
    return {
      status: 'error',
      detail: `${missing.map((n) => `'${n}'`).join(', ')} not exported (available: ${names.join(', ') || 'none'})`,
    }
  }
  return { status: 'ok', detail: `exports ${bindings.join(', ')}` }
}

/** The patch function itself: importable, and does it export that name? */
async function checkPatch(entry: PatchEntry): Promise<{ status: CheckStatus; detail: string } | null> {
  const spec = isAbsolute(entry.patch.from) ? pathToFileURL(entry.patch.from).href : entry.patch.from
  try {
    const mod = (await import(spec)) as Record<string, unknown>
    if (typeof mod[entry.patch.name] !== 'function') {
      return { status: 'error', detail: `patch '${entry.patch.name}' is not exported by ${entry.patch.from}` }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { status: 'error', detail: `patch module will not import: ${reason}` }
  }
  return null
}

/** A path match's candidate list, as an array whichever form was configured. */
function pathCandidates(path: string | string[]): string[] {
  return typeof path === 'string' ? [path] : path
}

function labelFor(entry: InstrumentEntry): string {
  if (entry.patch) {
    if (entry.module.path !== undefined) {
      return `path ${pathCandidates(entry.module.path).join(', ')}`
    }
    const range = entry.module.versionRange ? ` ${entry.module.versionRange}` : ''
    const files = entry.module.files ? ` · ${entry.module.files.join(', ')}` : ''
    return `${entry.module.name}${range}${files}`
  }
  return `wrap ${String(entry.match)} · ${entry.handler}`
}

async function checkEntry(entry: InstrumentEntry, cwd: string): Promise<EntryReport> {
  const label = labelFor(entry)

  if (!entry.patch) {
    // a wrap entry matches on the module's path at load time; there is no
    // package identity to resolve, so all that can be checked is the wrapper
    if (entry.wrapper.from && isAbsolute(entry.wrapper.from) && !existsSync(entry.wrapper.from)) {
      return { label, status: 'error', detail: `wrapper.from does not exist: ${entry.wrapper.from}` }
    }
    return { label, status: 'skipped', detail: 'wrap entry: matched on module path at load time' }
  }

  const patchProblem = await checkPatch(entry)
  if (patchProblem) return { label, ...patchProblem }

  if (entry.module.path !== undefined) {
    // A path-matched entry names files, not a package — often files that only
    // exist where the process runs (a Lambda handler under /var/task). What
    // exists here is checked like a declared package file; what does not is
    // not an error, because this tree may simply not be that environment.
    const present = pathCandidates(entry.module.path).filter((p) => isAbsolute(p) && existsSync(p))
    if (present.length === 0) {
      return { label, status: 'skipped', detail: 'no candidate path exists here — matched on module path at load time' }
    }
    const results = present.map((file) => ({ file, ...checkFile(file, entry.bindings) }))
    const failed = results.filter((r) => r.status === 'error')
    if (failed.length > 0) {
      return { label, status: 'error', detail: failed.map((r) => `${r.file}: ${r.detail}`).join('; ') }
    }
    if (results.every((r) => r.status === 'skipped')) {
      return { label, status: 'skipped', detail: results[0]!.detail }
    }
    return { label, status: 'ok', detail: `${results.map((r) => r.file).join(', ')} ok` }
  }

  if (isBuiltin(entry.module.name)) {
    if (entry.module.versionRange && !satisfies(process.versions.node, entry.module.versionRange)) {
      return {
        label,
        status: 'skipped',
        detail: `node ${process.versions.node} does not satisfy ${entry.module.versionRange}`,
      }
    }
    const target = createRequire(import.meta.url)(entry.module.name) as Record<string, unknown>
    const missing = entry.bindings.filter((name) => !(name in target))
    if (missing.length > 0) {
      return {
        label,
        status: 'error',
        detail: `${missing.map((n) => `'${n}'`).join(', ')} not found in ${entry.module.name}`,
      }
    }
    return { label, status: 'ok', detail: `builtin exports ${entry.bindings.join(', ')}` }
  }

  const located = locatePackage(entry.module.name, cwd)
  if (located === null) {
    return { label, status: 'error', detail: `package is not installed under ${cwd}` }
  }
  if (entry.module.versionRange && !satisfies(located.version, entry.module.versionRange)) {
    return {
      label,
      status: 'skipped',
      detail: `installed ${located.version} does not satisfy ${entry.module.versionRange} — this entry will not apply`,
    }
  }

  if (!entry.module.files) {
    // every file of the package is a candidate at load time; enumerating the
    // tree would say little, so check the entry point and say so
    const entryFile = resolveModule(entry.module.name, cwd)
    const detail = `installed ${located.version}, no 'files' filter: every file of the package is a candidate`
    if (entryFile === null) return { label, status: 'skipped', detail }
    const checked = checkFile(entryFile, entry.bindings)
    return { label, status: checked.status, detail: `${detail}; entry point ${checked.detail}` }
  }

  const results = entry.module.files.map((file) => ({ file, ...checkFile(join(located.root, file), entry.bindings) }))
  const failed = results.filter((r) => r.status === 'error')
  if (failed.length > 0) {
    return {
      label,
      status: 'error',
      detail: `installed ${located.version}; ${failed.map((r) => `${r.file}: ${r.detail}`).join('; ')}`,
    }
  }
  const unverifiable = results.filter((r) => r.status === 'skipped')
  if (unverifiable.length === results.length) {
    return { label, status: 'skipped', detail: `installed ${located.version}; ${results[0]!.detail}` }
  }
  return { label, status: 'ok', detail: `installed ${located.version}; ${results.map((r) => r.file).join(', ')} ok` }
}

/**
 * Check every entry of a config against the tree installed under `cwd`.
 *
 * `ok` is false when any entry reports `error` — which is what makes this
 * usable as a CI gate. A `skipped` entry is not a failure: a version gate that
 * excludes this environment, or a CJS target whose exports no static check can
 * see, is the config working as designed.
 */
export async function validateConfig(
  config: InstrumentConfig,
  options: { cwd?: string } = {},
): Promise<ValidationReport> {
  const cwd = options.cwd ?? process.cwd()
  const entries: EntryReport[] = []
  for (const entry of config.entries) {
    try {
      entries.push(await checkEntry(entry, cwd))
    } catch (err) {
      // a check that itself blows up (an unparseable target, a config shape
      // the matcher rejects) is a finding, not a crash of the validator
      const reason = err instanceof Error ? err.message : String(err)
      entries.push({ label: labelFor(entry), status: 'error', detail: `check failed: ${reason}` })
    }
  }
  const counts: Record<CheckStatus, number> = { ok: 0, skipped: 0, error: 0 }
  for (const report of entries) counts[report.status] += 1
  return { entries, counts, ok: counts.error === 0 }
}

/** The report as text, one line per entry plus a summary. */
export function formatReport(report: ValidationReport, cwd: string): string {
  const count = report.entries.length
  const lines = [`wrap-esm-lambda: ${count} config ${count === 1 ? 'entry' : 'entries'} against ${cwd}`, '']
  const mark: Record<CheckStatus, string> = { ok: 'ok     ', skipped: 'skipped', error: 'ERROR  ' }
  for (const entry of report.entries) {
    lines.push(`  ${mark[entry.status]} ${entry.label}`)
    lines.push(`          ${entry.detail}`)
  }
  const { ok, skipped, error } = report.counts
  lines.push('', `${error} error${error === 1 ? '' : 's'}, ${skipped} skipped, ${ok} ok`)
  return lines.join('\n')
}
