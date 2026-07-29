#!/usr/bin/env node
// Turn `pnpm audit` and `cargo audit` JSON into things a human can read from a
// phone: check-run annotations, a step summary table, and SARIF for the
// Security tab.
//
// The problem this solves is narrow and specific. A bare `pnpm audit` that
// exits 1 produces exactly one annotation — "Process completed with exit code
// 1", auto-generated, titled after the job — because the findings went to
// stdout and stdout is the log, not the run summary. Every advisory detail is
// one click and a scroll away. Everything below exists to put the advisory id,
// the package, the severity and the fix on the run page itself.
//
// Three inputs, one process, one exit decision: reading all three reports
// before deciding anything is what lets the gate fail on the published tree
// while the dev tree merely warns, and still get every finding into the
// summary and the SARIF upload.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd()
const PNPM_LOCK = 'pnpm-lock.yaml'
const CARGO_LOCK = 'Cargo.lock'

// GitHub renders at most ten annotations per level per step. Past that they are
// silently dropped, which would be a worse failure than not emitting them: a
// truncated list that looks complete. Cap deliberately, say so in the last
// annotation, and let the step summary carry the full set.
const ANNOTATION_CAP = 10

// Code scanning reads `security-severity` as a CVSS-shaped number and derives
// the alert's severity badge from it. npm's severity words map onto the bands
// GitHub uses (critical >= 9.0, high >= 7.0, medium >= 4.0, low >= 0.1).
const NPM_SEVERITY = {
  critical: { score: '9.8', level: 'error', rank: 4 },
  high: { score: '7.5', level: 'error', rank: 3 },
  moderate: { score: '5.5', level: 'warning', rank: 2 },
  low: { score: '3.1', level: 'note', rank: 1 },
  info: { score: '0.0', level: 'note', rank: 0 },
}

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info']

// ---------------------------------------------------------------------------
// Workflow command plumbing
// ---------------------------------------------------------------------------

// Workflow commands are line-oriented, so anything that could contain a newline
// or a delimiter has to be percent-encoded or the command silently truncates.
const escapeData = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProperty = (value) => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')

// A markdown table row ends at a newline and its cells are split on `|`, and
// every value in one of these tables comes from an advisory feed rather than
// from here. Backslashes have to be escaped *first*: escaping the pipe first
// and the backslash second would escape the escape, handing the `|` back its
// meaning and splitting the row — the exact thing the escaping was for.
//
// Backticks do not help. A `|` inside a code span still ends the cell, and npm
// patched ranges really do contain them (`>=4.17.24 || >=5.0.0`), so the
// version columns need this as much as the prose does.
const markdownCell = (value) => String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

function annotate(level, { file, line, title, message }) {
  const props = []
  if (file) props.push(`file=${escapeProperty(file)}`)
  if (line) props.push(`line=${escapeProperty(line)}`)
  if (title) props.push(`title=${escapeProperty(title)}`)
  const suffix = props.length ? ` ${props.join(',')}` : ''
  process.stdout.write(`::${level}${suffix}::${escapeData(message)}\n`)
}

const summaryChunks = []
const summary = (markdown) => summaryChunks.push(markdown)

function flushSummary() {
  const body = `${summaryChunks.join('\n')}\n`
  const target = process.env.GITHUB_STEP_SUMMARY
  if (target) appendFileSync(target, body)
  else process.stdout.write(`\n${body}`)
}

// ---------------------------------------------------------------------------
// Lockfile anchoring
// ---------------------------------------------------------------------------

// An annotation carrying `file` and `line` is rendered inline in a pull
// request's Files changed tab, next to the lockfile line that introduced the
// package. Without a line it is a footnote on the run; with one it lands on the
// diff that caused it.

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function readLines(relativePath) {
  try {
    return readFileSync(resolve(WORKSPACE, relativePath), 'utf8').split('\n')
  } catch {
    return null
  }
}

const lockCache = new Map()
function lockLines(relativePath) {
  if (!lockCache.has(relativePath)) lockCache.set(relativePath, readLines(relativePath))
  return lockCache.get(relativePath)
}

// pnpm's lockfile lists every resolved package under `packages:` as
// `  name@version:` — and again under `snapshots:`, which is why the search
// starts at the `packages:` header rather than the top of the file. Peer suffixes
// (`name@1.0.0(peer@2.0.0)`) are matched but not required.
function pnpmLockLine(name, version) {
  const lines = lockLines(PNPM_LOCK)
  if (!lines) return null
  const start = lines.findIndex((line) => line === 'packages:')
  if (start === -1) return null
  const exact = new RegExp(`^ {2}'?${escapeRegExp(`${name}@${version}`)}'?[(:]`)
  const loose = new RegExp(`^ {2}'?${escapeRegExp(`${name}@`)}`)
  for (let i = start + 1; i < lines.length; i += 1) {
    if (exact.test(lines[i])) return i + 1
  }
  // The advisory's version and the lockfile's can drift apart (aliases, patched
  // installs). Landing on the package is still better than landing nowhere.
  for (let i = start + 1; i < lines.length; i += 1) {
    if (loose.test(lines[i])) return i + 1
  }
  return null
}

// Cargo.lock is TOML: a `[[package]]` table with `name` and `version` keys. The
// annotation anchors to the `name` line of the block whose version matches.
function cargoLockLine(name, version) {
  const lines = lockLines(CARGO_LOCK)
  if (!lines) return null
  const nameLine = `name = "${name}"`
  let fallback = null
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== nameLine) continue
    fallback ??= i + 1
    const versionLine = lines[i + 1]?.trim()
    if (!version || versionLine === `version = "${version}"`) return i + 1
  }
  return fallback
}

// ---------------------------------------------------------------------------
// SARIF
// ---------------------------------------------------------------------------

// One SARIF run per tool/scope. The upload step points at the directory, and
// GitHub combines them into a single submission, so each run needs its own tool
// driver to stay distinguishable in the Security tab.
function sarifRun({ toolName, informationUri, findings }) {
  const rules = []
  const ruleIndex = new Map()

  const results = findings.map((finding) => {
    if (!ruleIndex.has(finding.ruleId)) {
      ruleIndex.set(finding.ruleId, rules.length)
      rules.push({
        id: finding.ruleId,
        name: finding.ruleName,
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.description || finding.title },
        help: { text: finding.help, markdown: finding.helpMarkdown },
        helpUri: finding.helpUri,
        properties: {
          tags: finding.tags,
          'security-severity': finding.score,
        },
      })
    }
    const index = ruleIndex.get(finding.ruleId)
    const region = finding.line ? { startLine: finding.line } : undefined
    return {
      ruleId: finding.ruleId,
      ruleIndex: index,
      level: finding.level,
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: finding.file },
            ...(region ? { region } : {}),
          },
        },
      ],
      // Without a stable fingerprint GitHub keys alerts on file and line, so a
      // lockfile reshuffle would close every alert and open it again. The
      // advisory plus the dependency path is what actually identifies a finding.
      partialFingerprints: {
        auditFindingId: `${finding.ruleId}::${finding.fingerprint}`,
      },
    }
  })

  return {
    tool: { driver: { name: toolName, informationUri, rules } },
    results,
  }
}

function writeSarif(path, run) {
  const document = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [run],
  }
  mkdirSync(dirname(resolve(WORKSPACE, path)), { recursive: true })
  writeFileSync(resolve(WORKSPACE, path), `${JSON.stringify(document, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

class ReportError extends Error {}

// `pnpm audit` exits non-zero when it finds something, which makes the exit code
// useless for telling "found advisories" apart from "the registry was
// unreachable". Parseability is the honest check: a report that does not parse
// into the shape we expect is a broken run, not a clean tree, and a gate that
// reads a broken run as clean is not a gate.
function loadReport(path, validate) {
  let raw
  try {
    raw = readFileSync(resolve(WORKSPACE, path), 'utf8')
  } catch (error) {
    throw new ReportError(`could not read ${path}: ${error.message}`)
  }
  if (!raw.trim()) throw new ReportError(`${path} is empty — the audit produced no report at all`)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const head = raw.trim().split('\n').slice(0, 3).join(' / ')
    throw new ReportError(`${path} is not JSON (${error.message}); output began: ${head}`)
  }
  validate(parsed, path)
  return parsed
}

function parsePnpm(report, { scope, dev }) {
  const advisories = Object.values(report.advisories ?? {})
  const findings = []

  for (const advisory of advisories) {
    const severity = String(advisory.severity ?? 'info').toLowerCase()
    const meta = NPM_SEVERITY[severity] ?? NPM_SEVERITY.info
    const ruleId = advisory.github_advisory_id || `pnpm-audit/${advisory.id}`
    const paths = advisory.findings?.flatMap((entry) => entry.paths ?? []) ?? []
    const versions = [...new Set(advisory.findings?.map((entry) => entry.version).filter(Boolean) ?? [])]
    const version = versions[0] ?? null
    const fix = advisory.patched_versions && advisory.patched_versions !== '<0.0.0' ? advisory.patched_versions : null

    // The dependency path is the part a reader actually needs: which of our
    // direct dependencies drags the vulnerable package in. Show one, count the rest.
    const primaryPath = paths[0] ? paths[0].replace(/^\.>/, '') : advisory.module_name
    const extraPaths = paths.length > 1 ? ` (+${paths.length - 1} more path${paths.length > 2 ? 's' : ''})` : ''

    findings.push({
      severity,
      rank: meta.rank,
      score: meta.score,
      level: meta.level,
      ruleId,
      ruleName: `${advisory.module_name}/${severity}`,
      title: advisory.title,
      description: advisory.title,
      module: advisory.module_name,
      version,
      fix,
      url: advisory.url,
      helpUri: advisory.url,
      help: `${advisory.title}\n\nAffected: ${advisory.vulnerable_versions}\nFixed in: ${fix ?? 'no fix available'}\nPath: ${primaryPath}`,
      helpMarkdown: [
        `**${markdownCell(advisory.title)}**`,
        '',
        `| | |`,
        `| --- | --- |`,
        `| Package | \`${markdownCell(advisory.module_name)}\` |`,
        `| Affected | \`${markdownCell(advisory.vulnerable_versions)}\` |`,
        `| Fixed in | ${fix ? `\`${markdownCell(fix)}\`` : '_no fix available_'} |`,
        `| Path | \`${markdownCell(primaryPath)}\` |`,
        `| Advisory | ${markdownCell(advisory.url)} |`,
      ].join('\n'),
      tags: ['security', 'dependency', scope === 'prod' ? 'published-dependency' : 'dev-dependency'],
      file: PNPM_LOCK,
      line: version ? pnpmLockLine(advisory.module_name, version) : null,
      fingerprint: primaryPath,
      annotationTitle: `${severity} · ${advisory.module_name}${version ? `@${version}` : ''} · ${ruleId}`,
      message: `${advisory.title}${fix ? ` — fixed in ${fix}` : ' — no fix available yet'}. Path: ${primaryPath}${extraPaths}. ${advisory.url}`,
      dev,
    })
  }

  findings.sort((a, b) => b.rank - a.rank || a.module.localeCompare(b.module))
  return findings
}

// `advisory.url` points at the upstream issue or pull request that reported the
// problem, which is not the page a reader wants first. The RUSTSEC advisory page
// is the canonical write-up, so prefer it and keep the upstream link as backup.
const rustsecUrl = (advisory) =>
  advisory.id?.startsWith('RUSTSEC-')
    ? `https://rustsec.org/advisories/${advisory.id}.html`
    : (advisory.url ?? 'https://rustsec.org/')

function parseCargo(report) {
  const findings = []

  for (const entry of report.vulnerabilities?.list ?? []) {
    const advisory = entry.advisory ?? {}
    const pkg = entry.package ?? {}
    const patched = entry.versions?.patched ?? []
    const fix = patched.length ? patched.join(', ') : null
    // cargo-audit reports a CVSS vector rather than a score, and deriving a
    // number from the vector is more machinery than this is worth. Everything
    // `cargo audit` calls a vulnerability is treated as high; the warning kinds
    // below (unmaintained, yanked) are informational by construction.
    findings.push({
      kind: 'vulnerability',
      rank: 3,
      score: '7.5',
      level: 'error',
      ruleId: advisory.id ?? `cargo-audit/${pkg.name}`,
      ruleName: `${pkg.name}/vulnerability`,
      title: advisory.title ?? 'Vulnerable crate',
      description: advisory.description ?? advisory.title ?? '',
      module: pkg.name,
      version: pkg.version,
      fix,
      url: rustsecUrl(advisory),
      helpUri: rustsecUrl(advisory),
      help: `${advisory.title ?? ''}\n\nFixed in: ${fix ?? 'no patched release'}`,
      helpMarkdown: [
        `**${markdownCell(advisory.title ?? 'Vulnerable crate')}**`,
        '',
        `| | |`,
        `| --- | --- |`,
        `| Crate | \`${markdownCell(`${pkg.name} ${pkg.version}`)}\` |`,
        `| Fixed in | ${fix ? `\`${markdownCell(fix)}\`` : '_no patched release_'} |`,
        `| Advisory | ${markdownCell(rustsecUrl(advisory))} |`,
      ].join('\n'),
      tags: ['security', 'dependency', 'rust'],
      file: CARGO_LOCK,
      line: cargoLockLine(pkg.name, pkg.version),
      fingerprint: `${pkg.name}@${pkg.version}`,
      annotationTitle: `vulnerability · ${pkg.name} ${pkg.version} · ${advisory.id ?? 'RUSTSEC'}`,
      message: `${advisory.title ?? 'Vulnerable crate'}${fix ? ` — fixed in ${fix}` : ' — no patched release'}. ${rustsecUrl(advisory)}`,
    })
  }

  // `warnings` is keyed by kind (`unmaintained`, `yanked`, `unsound`…), and the
  // set of kinds grows over time, so read whatever keys are present rather than
  // naming them.
  for (const [kind, entries] of Object.entries(report.warnings ?? {})) {
    for (const entry of entries ?? []) {
      const advisory = entry.advisory ?? {}
      const pkg = entry.package ?? {}
      const title = advisory.title ?? `Crate is ${kind}`
      findings.push({
        kind,
        rank: 1,
        score: '3.1',
        level: 'note',
        ruleId: advisory.id ?? `cargo-audit/${kind}`,
        ruleName: `${pkg.name}/${kind}`,
        title,
        description: advisory.description ?? title,
        module: pkg.name,
        version: pkg.version,
        fix: null,
        url: rustsecUrl(advisory),
        helpUri: rustsecUrl(advisory),
        help: title,
        helpMarkdown: `**${markdownCell(title)}**\n\nCrate: \`${markdownCell(`${pkg.name} ${pkg.version}`)}\``,
        tags: ['security', 'dependency', 'rust', kind],
        file: CARGO_LOCK,
        line: cargoLockLine(pkg.name, pkg.version),
        fingerprint: `${kind}:${pkg.name}@${pkg.version}`,
        annotationTitle: `${kind} · ${pkg.name} ${pkg.version}${advisory.id ? ` · ${advisory.id}` : ''}`,
        message: `${title}. ${rustsecUrl(advisory)}`,
      })
    }
  }

  findings.sort((a, b) => b.rank - a.rank || a.module.localeCompare(b.module))
  return findings
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// The cap is per level per step, not per group, so the queue is filled from
// every group first and rationed once. Emitting per group would quietly blow the
// budget the moment two groups share a level — which dev-only advisories and
// cargo's unmaintained warnings always do.
const pending = { error: [], warning: [], notice: [] }

function queueAnnotations(findings, level, heading) {
  for (const finding of findings) {
    pending[level].push({
      file: finding.file,
      line: finding.line,
      title: `${heading}: ${finding.annotationTitle}`,
      message: finding.message,
    })
  }
}

function flushAnnotations() {
  for (const [level, queue] of Object.entries(pending)) {
    if (!queue.length) continue
    if (queue.length <= ANNOTATION_CAP) {
      for (const annotation of queue) annotate(level, annotation)
      continue
    }
    // Spend the last slot of the budget saying what the other slots could not.
    for (const annotation of queue.slice(0, ANNOTATION_CAP - 1)) annotate(level, annotation)
    const hidden = queue.length - (ANNOTATION_CAP - 1)
    annotate(level, {
      title: `${hidden} more finding${hidden === 1 ? '' : 's'} at this level`,
      message: `GitHub renders at most ${ANNOTATION_CAP} annotations per level per step. The full list is in the job summary.`,
    })
  }
}

const countsBySeverity = (findings) => {
  const counts = new Map()
  for (const finding of findings) {
    const key = finding.severity ?? finding.kind
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function renderCounts(findings) {
  const counts = countsBySeverity(findings)
  const keys = [...counts.keys()].sort((a, b) => {
    const ai = SEVERITY_ORDER.indexOf(a)
    const bi = SEVERITY_ORDER.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b)
  })
  return keys.map((key) => `${counts.get(key)} ${key}`).join(', ')
}

function renderTable(findings, firstColumn) {
  const columns = [firstColumn, 'Package', 'Advisory', 'Fixed in', 'Reference']
  const rows = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`]
  for (const finding of findings) {
    const reference = markdownCell(finding.ruleId)
    const advisory = finding.url ? `[${reference}](${encodeURI(finding.url)})` : reference
    const pkg = markdownCell(`${finding.module}${finding.version ? `@${finding.version}` : ''}`)
    const title = markdownCell(finding.title)
    const fix = finding.fix ? `\`${markdownCell(finding.fix)}\`` : '—'
    rows.push(`| ${finding.severity ?? finding.kind} | \`${pkg}\` | ${title} | ${fix} | ${advisory} |`)
  }
  return rows.join('\n')
}

function section(title, findings, emptyNote, firstColumn = 'Severity') {
  summary(`### ${title}`)
  summary('')
  if (!findings.length) {
    summary(emptyNote)
    summary('')
    return
  }
  summary(`**${findings.length} finding${findings.length === 1 ? '' : 's'}** — ${renderCounts(findings)}`)
  summary('')
  summary(renderTable(findings, firstColumn))
  summary('')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const REQUIRED_ARGS = ['pnpm-prod', 'pnpm-dev', 'cargo']

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new ReportError(`unexpected argument: ${key}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new ReportError(`${key} needs a value`)
    args[key.slice(2)] = value
    i += 1
  }
  const missing = REQUIRED_ARGS.filter((name) => !args[name])
  if (missing.length) throw new ReportError(`missing required argument(s): ${missing.map((n) => `--${n}`).join(', ')}`)
  return args
}

function validatePnpm(report, path) {
  if (typeof report !== 'object' || report === null || !('advisories' in report) || !('metadata' in report)) {
    throw new ReportError(`${path} parsed as JSON but is not a pnpm audit report (no advisories/metadata)`)
  }
}

function validateCargo(report, path) {
  if (typeof report !== 'object' || report === null || !('vulnerabilities' in report)) {
    throw new ReportError(`${path} parsed as JSON but is not a cargo audit report (no vulnerabilities)`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = args['sarif-dir'] ?? 'sarif'

  const prod = parsePnpm(loadReport(args['pnpm-prod'], validatePnpm), { scope: 'prod', dev: false })
  const dev = parsePnpm(loadReport(args['pnpm-dev'], validatePnpm), { scope: 'dev', dev: true })
  const cargo = parseCargo(loadReport(args.cargo, validateCargo))

  // The dev tree is a superset of the published tree; listing the published
  // advisories twice would double every count in the summary and file two alerts
  // for one problem.
  const prodIds = new Set(prod.map((finding) => `${finding.ruleId}::${finding.fingerprint}`))
  const devOnly = dev.filter((finding) => !prodIds.has(`${finding.ruleId}::${finding.fingerprint}`))

  const cargoVulns = cargo.filter((finding) => finding.kind === 'vulnerability')
  const cargoWarnings = cargo.filter((finding) => finding.kind !== 'vulnerability')

  // Published dependencies and Rust crates block. Dev-only advisories warn:
  // nothing a consumer of this package installs is exposed to them, and a gate
  // that is always red is a gate everybody learns to ignore.
  queueAnnotations(prod, 'error', 'Published dependency')
  queueAnnotations(cargoVulns, 'error', 'Rust dependency')
  queueAnnotations(cargoWarnings, 'warning', 'Rust dependency')
  queueAnnotations(devOnly, 'warning', 'Dev-only dependency')
  flushAnnotations()

  summary('## Security audit')
  summary('')
  const blocking = prod.length + cargoVulns.length
  summary(
    blocking === 0
      ? '✅ **Nothing blocking.** Published dependencies and the Rust tree are clean.'
      : `❌ **${blocking} blocking finding${blocking === 1 ? '' : 's'}** in the published dependency tree or the Rust tree.`,
  )
  summary('')

  section(
    'Published dependencies (`pnpm audit --prod`)',
    prod,
    '✅ No known vulnerabilities in anything this package ships.',
  )
  section('Rust crates (`cargo audit`)', cargo, '✅ No advisories against anything in `Cargo.lock`.', 'Kind')
  section('Dev-only dependencies (`pnpm audit`, informational)', devOnly, '✅ No advisories in the dev tree either.')

  if (devOnly.length) {
    summary(
      '> Dev-only advisories do not fail the build. They reach bundlers, the benchmark chart generator and test helpers — nothing a consumer of this package installs.',
    )
    summary('')
  }

  writeSarif(
    `${outDir}/pnpm-audit-prod.sarif`,
    sarifRun({
      toolName: 'pnpm audit (published dependencies)',
      informationUri: 'https://pnpm.io/cli/audit',
      findings: prod,
    }),
  )
  writeSarif(
    `${outDir}/pnpm-audit-dev.sarif`,
    sarifRun({
      toolName: 'pnpm audit (dev tree)',
      informationUri: 'https://pnpm.io/cli/audit',
      findings: devOnly,
    }),
  )
  writeSarif(
    `${outDir}/cargo-audit.sarif`,
    sarifRun({
      toolName: 'cargo audit',
      informationUri: 'https://rustsec.org/',
      findings: cargo,
    }),
  )

  flushSummary()

  if (blocking > 0) {
    const parts = []
    if (prod.length) parts.push(`${prod.length} against published dependencies`)
    if (cargoVulns.length) parts.push(`${cargoVulns.length} against Rust crates`)
    annotate('error', {
      title: 'Security audit failed',
      message: `${parts.join(', ')}. The full table is in the job summary.`,
    })
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  if (error instanceof ReportError) {
    // A report we cannot read is a failed audit, never a clean one.
    annotate('error', { title: 'Security audit could not run', message: error.message })
    flushSummary()
    process.exitCode = 1
  } else {
    throw error
  }
}
