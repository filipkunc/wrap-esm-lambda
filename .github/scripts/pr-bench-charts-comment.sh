#!/bin/sh
# The release page embeds the committed benchmark charts; give the PR the
# same set where the conversation happens. A sticky comment (one marker, one
# comment, PATCHed in place on every push — the pr-cold-start-comment.sh
# pattern) embedding the committed reference charts pinned to the PR's head
# commit, plus pointers to THIS run's freshly rendered charts and
# base-vs-head tables, which live on the run page (a comment cannot embed a
# workflow artifact, and the step summary cannot be linked to directly).
# The Lambda cold-start chart is deliberately absent: it has its own sticky
# comment with live numbers. Environment: GITHUB_TOKEN, GITHUB_REPOSITORY,
# HEAD_SHA, PR_NUMBER, RUN_URL. HEAD_SHA must be the PR's head commit — the
# default GITHUB_SHA on pull_request events is the ephemeral merge commit,
# whose raw URLs rot once the merge ref is recomputed or collected.
set -eu
: "${GITHUB_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${HEAD_SHA:?}" "${PR_NUMBER:?}" "${RUN_URL:?}"

marker='<!-- benchmark-charts -->'
api="https://api.github.com/repos/$GITHUB_REPOSITORY"
raw="https://raw.githubusercontent.com/$GITHUB_REPOSITORY/$HEAD_SHA"
body_file=$(mktemp)

{
  echo "$marker"
  echo '### Benchmark charts'
  echo
  echo "The committed reference charts at $HEAD_SHA — the set the release page embeds. This run's own numbers: the [run summary]($RUN_URL) carries the base-vs-head cold-start table and both transform-latency tables, and the \`bench-charts\` artifact on the same page holds these charts re-rendered from this run."
  echo
  echo "**Per-module transform cost, one bar per tool** ([cases](https://github.com/$GITHUB_REPOSITORY/blob/$HEAD_SHA/benchmark/tap-cases.ts)):"
  echo
  echo "![Per-module transform cost, one bar per tool]($raw/hooks/tapMechanismChart.svg)"
  echo
  echo '**The two engines in detail** (tiers, plumbing, input sizes):'
  echo
  echo "![The two engines in detail]($raw/hooks/tapEngineChart.svg)"
  echo
  echo '**Cold start by hooking mechanism** (hyperfine, committed table):'
  echo
  echo "![Cold start by hooking mechanism]($raw/hooks/benchChart.svg)"
} > "$body_file"

auth="Authorization: Bearer $GITHUB_TOKEN"
accept='Accept: application/vnd.github+json'

existing=$(curl -s -H "$auth" -H "$accept" \
  "$api/issues/$PR_NUMBER/comments?per_page=100" |
  jq -r --arg marker "$marker" '[.[] | select(.body | startswith($marker))][0].id // empty')

payload=$(jq -n --rawfile body "$body_file" '{body: $body}')
if [ -n "$existing" ]; then
  curl -sf -X PATCH -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
    "$api/issues/comments/$existing" -d "$payload" >/dev/null
  echo "updated sticky comment $existing on PR #$PR_NUMBER"
else
  curl -sf -X POST -H "$auth" -H "$accept" -H 'Content-Type: application/json' \
    "$api/issues/$PR_NUMBER/comments" -d "$payload" >/dev/null
  echo "posted sticky comment on PR #$PR_NUMBER"
fi
