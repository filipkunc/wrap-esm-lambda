// Where a generated report goes.
//
// The committed .md files are a snapshot: they only change when somebody
// runs the command and commits the result, which is right for a file people
// read in the repo but useless for "what did THIS run measure". So every
// run also appends its report to the job summary when one exists
// ($GITHUB_STEP_SUMMARY), which puts the tables on the workflow run page of
// every PR that touches the corpus — no commit, no bot comment, and no
// per-runner timing noise in the diff. The same pattern the security-audit
// script already uses (.github/scripts/audit-report.mjs).
import { appendFileSync, writeFileSync } from 'node:fs'

export interface PublishOptions {
  /** absolute path of the committed snapshot to (over)write */
  file: string
  /** the generated markdown */
  markdown: string
  /** heading for the job-summary copy, so several reports can share a run */
  summaryTitle: string
  /** false for a filtered/subset run: print, do not overwrite the snapshot */
  writeSnapshot: boolean
}

export function publishReport({ file, markdown, summaryTitle, writeSnapshot }: PublishOptions): void {
  if (writeSnapshot) {
    writeFileSync(file, markdown)
    console.error(`written to ${file}`)
  } else {
    console.log(markdown)
  }

  const summary = process.env.GITHUB_STEP_SUMMARY
  if (!summary) return
  // the snapshot's relative image link cannot resolve in a job summary, so
  // the summary copy points at the run's uploaded artifact instead
  const forSummary = markdown
    .replace(/^!\[[^\]]*]\([^)]*\)$/gm, '_(chart in the `corpus-results` artifact on this run)_')
    .replace(/^# /, '## ')
  appendFileSync(summary, `\n<details open><summary>${summaryTitle}</summary>\n\n${forSummary}\n</details>\n`)
  console.error(`appended to the job summary: ${summaryTitle}`)
}
