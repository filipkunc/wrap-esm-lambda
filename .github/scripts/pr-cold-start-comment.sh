#!/bin/sh
# Put the delivery contrast where the conversation happens: a sticky PR
# comment with this run's billed cold starts as a mermaid chart (GitHub
# renders it in comments — no image hosting involved) and the committed
# reference chart under it. One marker, one comment, PATCHed in place on
# every push instead of piling up. Environment: GITHUB_TOKEN,
# GITHUB_REPOSITORY, HEAD_SHA, PR_NUMBER, RUNTIME_COLD, BUILT_COLD,
# IMAGE, PLATFORM. HEAD_SHA must be the PR's head commit — the default
# GITHUB_SHA on pull_request events is the ephemeral merge commit, whose
# raw URLs rot once the merge ref is recomputed or collected.
set -eu
: "${GITHUB_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${HEAD_SHA:?}" "${PR_NUMBER:?}"

marker='<!-- hono-lambda-cold-start -->'
api="https://api.github.com/repos/$GITHUB_REPOSITORY"
body_file=$(mktemp)

is_num() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

{
  echo "$marker"
  echo '### Cold start by delivery — live from this run'
  echo
  echo "\`${IMAGE:-the Lambda runtime image}\` (${PLATFORM:-}), billed by the emulator's REPORT line, cold boot of \`app.handler\` at $HEAD_SHA:"
  echo
  if is_num "${RUNTIME_COLD:-}" && is_num "${BUILT_COLD:-}"; then
    max=$RUNTIME_COLD
    [ "$BUILT_COLD" -gt "$max" ] && max=$BUILT_COLD
    limit=$(((max * 12 + 9) / 10))
    echo '```mermaid'
    echo 'xychart-beta'
    echo '  title "Cold start, billed (ms)"'
    echo '  x-axis ["runtime hook", "esbuild bundle"]'
    echo "  y-axis \"ms\" 0 --> $limit"
    echo "  bar [$RUNTIME_COLD, $BUILT_COLD]"
    echo '```'
  else
    echo '_No numbers made it out of this run — see the Lambda lane job summary._'
  fi
  echo
  echo "The committed reference measurement ([table](https://github.com/$GITHUB_REPOSITORY/blob/$HEAD_SHA/examples/hono-lambda/coldStartTable.md)):"
  echo
  echo "![Cold start by delivery](https://raw.githubusercontent.com/$GITHUB_REPOSITORY/$HEAD_SHA/examples/hono-lambda/coldStartChart.svg)"
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
