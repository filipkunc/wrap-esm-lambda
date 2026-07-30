#!/bin/sh
# Boot the hono-lambda example on the real Lambda runtime image and answer
# the example's events through the runtime interface emulator — the two API
# Gateway events against app.handler, the SQS batch against consumer.handler
# (one container boots one handler), and then the delivery-cost measurement,
# WITHIN each artifact, because the two deliveries are not substitutes:
# bundling erases the module boundaries the runtime hook's package entries
# match, and an unbundled deployment gives the unplugin no build to ride.
#
#   unbundled: no instrumentation vs the runtime hook  -> the hook's cost
#   bundled:   plain bundle vs patches baked           -> the unplugin's cost
#
# Read the platform's own accounting — the REPORT line's duration, billed
# milliseconds and memory — back off the container logs, next to the patch's
# in-process numbers. Every layer of the example's config must have spoken
# in the logs (and stayed silent in the uninstrumented controls) or the
# script fails. Usage:
#   hono-lambda-rie.sh <image> <platform> [summary-file]
set -eu
image=$1
platform=$2
summary=${3:-/dev/null}

workspace=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
example="$workspace/examples/hono-lambda"
name_app=ric-hono
name_consumer=ric-hono-consumer
name_built=ric-hono-built
name_baseline=ric-hono-baseline
name_plain=ric-hono-plain
port_app=9103
port_consumer=9104
port_built=9105
port_baseline=9106
port_plain=9107

cleanup() {
  docker rm -f "$name_app" "$name_consumer" "$name_built" "$name_baseline" "$name_plain" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# boot <name> <port> <task-root> <handler> [hook]: the runtime delivery
# passes hook=1 and gets the preload flag and the config; every other
# container gets neither — the bundles carry their instrumentation (or
# deliberately none) themselves.
boot() {
  if [ "${5:-}" = 1 ]; then
    docker run -d --name "$1" \
      --platform "$platform" \
      -p "$2:8080" \
      -v "$workspace:$workspace" \
      -w "$example" \
      -e LAMBDA_TASK_ROOT="$3" \
      -e AWS_LAMBDA_FUNCTION_MEMORY_SIZE=512 \
      -e NODE_OPTIONS="--import @wrap-esm-lambda/hooks/register" \
      -e WRAP_ESM_LAMBDA_CONFIG="$example/wrap.config.mjs" \
      -e WRAP_ESM_LAMBDA_ENGINE="${WRAP_ESM_LAMBDA_ENGINE:-oxc}" \
      "$image" "$4" >/dev/null
  else
    docker run -d --name "$1" \
      --platform "$platform" \
      -p "$2:8080" \
      -v "$workspace:$workspace" \
      -w "$example" \
      -e LAMBDA_TASK_ROOT="$3" \
      -e AWS_LAMBDA_FUNCTION_MEMORY_SIZE=512 \
      "$image" "$4" >/dev/null
  fi
}

invoke() {
  port=$1
  event=$2
  body=''
  for _ in $(seq 1 30); do
    body=$(curl -s --max-time 20 -XPOST \
      "http://localhost:$port/2015-03-31/functions/function/invocations" \
      -d "@$example/events/$event.json" || true)
    [ -n "$body" ] && break
    sleep 1
  done
  printf '%s' "$body"
}

# first Billed Duration in a log — the cold start, the number Lambda bills
cold_billed() {
  printf '%s\n' "$1" | grep 'REPORT RequestId' | head -1 |
    sed 's/.*Billed Duration: \([0-9][0-9]*\) ms.*/\1/'
}

is_num() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# delta <a> <b>: "+N ms" / "-N ms", or "?" when either number is missing
delta() {
  if is_num "$1" && is_num "$2"; then
    d=$(($2 - $1))
    case "$d" in -*) printf '%s ms' "$d" ;; *) printf '+%s ms' "$d" ;; esac
  else
    printf '?'
  fi
}

# Build both bundles INSIDE the image (a prior in-container suite run may
# have left a root-owned dist/ on the mounted workspace that the runner
# user cannot overwrite — and the image's own node is the more honest
# builder anyway): the instrumented dist/ and the dist-plain/ control.
docker run --rm \
  --platform "$platform" \
  --entrypoint /bin/sh \
  -v "$workspace:$workspace" \
  -w "$example" \
  -e WRAP_ESM_LAMBDA_ENGINE="${WRAP_ESM_LAMBDA_ENGINE:-oxc}" \
  "$image" -c 'node build.mjs && node build.mjs --plain' >/dev/null

boot "$name_baseline" "$port_baseline" "$example" app.handler
baseline_get=$(invoke "$port_baseline" get-quote)

boot "$name_app" "$port_app" "$example" app.handler 1
get=$(invoke "$port_app" get-quote)
post=$(invoke "$port_app" post-quote)

# The REPORT line's Max Memory Used is an echo of the configured size: the
# emulator meters time, not memory (vary AWS_LAMBDA_FUNCTION_MEMORY_SIZE and
# the field tracks it exactly, whatever the process actually used). A real
# Lambda reports genuine peak memory in the same field. Locally the genuine
# number lives in the container's own cgroup — read it while the container
# still runs, either hierarchy flavor.
peak_bytes=$(docker exec "$name_app" sh -c \
  'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null' \
  2>/dev/null || true)
case "$peak_bytes" in
  '' | *[!0-9]*) peak='unavailable' ;;
  *) peak="$((peak_bytes / 1024 / 1024)) MB" ;;
esac

boot "$name_consumer" "$port_consumer" "$example" consumer.handler 1
sqs=$(invoke "$port_consumer" sqs-batch)

boot "$name_plain" "$port_plain" "$example/dist-plain" app.handler
plain_get=$(invoke "$port_plain" get-quote)

boot "$name_built" "$port_built" "$example/dist" app.handler
built_get=$(invoke "$port_built" get-quote)
built_post=$(invoke "$port_built" post-quote)

# The handler's body arrives JSON-escaped inside the invocation envelope
# ({\"stored\":\"7\"}), so quoted-key needles can never match there — assert
# on quote-free body fragments and the envelope's own unescaped statusCode.
# The consumer has no envelope: a direct invocation returns the handler's
# own JSON, so its keys match unescaped.
ok=1
case "$baseline_get" in *'Simplicity is prerequisite for reliability.'*) ;; *) echo 'baseline GET body missing the quote'; ok=0 ;; esac
case "$get" in *'Simplicity is prerequisite for reliability.'*) ;; *) echo 'GET body missing the quote'; ok=0 ;; esac
case "$get" in *'"statusCode":200'*) ;; *) echo 'GET did not return 200'; ok=0 ;; esac
case "$post" in *stored*) ;; *) echo 'POST body missing stored'; ok=0 ;; esac
case "$post" in *'"statusCode":201'*) ;; *) echo 'POST did not return 201'; ok=0 ;; esac
case "$sqs" in *'"batchItemFailures"'*) ;; *) echo 'SQS response missing the partial-batch contract'; ok=0 ;; esac
case "$sqs" in *broken-3*) ;; *) echo 'SQS response missing the malformed record redrive'; ok=0 ;; esac
case "$plain_get" in *'Simplicity is prerequisite for reliability.'*) ;; *) echo 'plain-bundle GET body missing the quote'; ok=0 ;; esac
case "$built_get" in *'Simplicity is prerequisite for reliability.'*) ;; *) echo 'build-mode GET body missing the quote'; ok=0 ;; esac
case "$built_post" in *'"statusCode":201'*) ;; *) echo 'build-mode POST did not return 201'; ok=0 ;; esac

logs=$(docker logs "$name_app" 2>&1)
consumer_logs=$(docker logs "$name_consumer" 2>&1)
built_logs=$(docker logs "$name_built" 2>&1)
baseline_logs=$(docker logs "$name_baseline" 2>&1)
plain_logs=$(docker logs "$name_plain" 2>&1)

# every layer must have spoken: the route template from the hono entry, the
# SDK operations from the smithy entry (no network, no LocalStack — S3 under
# the HTTP handler, SNS under the SQS consumer), and the in-process timing
# from the handler entry — in BOTH deliveries; the build-mode container has
# no hook, so its lines prove the bundle carries the patches itself
for needle in \
  'http.route = GET /quotes/:id -> 200' \
  'http.route = POST /quotes -> 201' \
  'aws.operation = PutObjectCommand' \
  'invocation = '; do
  case "$logs" in *"$needle"*) ;; *) echo "missing from app logs: $needle"; ok=0 ;; esac
  case "$built_logs" in *"$needle"*) ;; *) echo "missing from build-mode logs: $needle"; ok=0 ;; esac
done
for needle in \
  'aws.operation = PublishCommand' \
  'invocation = '; do
  case "$consumer_logs" in *"$needle"*) ;; *) echo "missing from consumer logs: $needle"; ok=0 ;; esac
done
# and the uninstrumented controls must have stayed silent — a patch line in
# either means the measurement is not measuring what it claims
for control in baseline plain; do
  eval "control_logs=\$${control}_logs"
  case "$control_logs" in
    *'http.route = '* | *'invocation = '*) echo "$control control is instrumented — the contrast is void"; ok=0 ;;
  esac
done

if [ "$ok" -ne 1 ]; then
  echo "baseline GET -> ${baseline_get:-<no response>}"
  echo "GET  -> ${get:-<no response>}"
  echo "POST -> ${post:-<no response>}"
  echo "SQS  -> ${sqs:-<no response>}"
  echo "plain GET -> ${plain_get:-<no response>}"
  echo "built GET  -> ${built_get:-<no response>}"
  echo "built POST -> ${built_post:-<no response>}"
  echo '--- baseline container logs ---'
  printf '%s\n' "$baseline_logs"
  echo '--- app container logs ---'
  printf '%s\n' "$logs"
  echo '--- consumer container logs ---'
  printf '%s\n' "$consumer_logs"
  echo '--- plain-bundle container logs ---'
  printf '%s\n' "$plain_logs"
  echo '--- build-mode container logs ---'
  printf '%s\n' "$built_logs"
  exit 1
fi

baseline_cold=$(cold_billed "$baseline_logs")
hook_cold=$(cold_billed "$logs")
plain_cold=$(cold_billed "$plain_logs")
built_cold=$(cold_billed "$built_logs")

echo "GET  -> $get"
echo "POST -> $post"
echo "SQS  -> $sqs"
echo "container cgroup peak: $peak"
echo "unbundled: no instrumentation ${baseline_cold:-?} ms -> runtime hook ${hook_cold:-?} ms (hook cost $(delta "${baseline_cold:-}" "${hook_cold:-}"))"
echo "bundled:   no patches ${plain_cold:-?} ms -> patches baked ${built_cold:-?} ms (unplugin cost $(delta "${plain_cold:-}" "${built_cold:-}"))"
printf '%s\n%s\n%s\n' "$logs" "$consumer_logs" "$built_logs" |
  grep -E 'REPORT|invocation = |http\.route = |aws\.operation = ' || true

# Three views of the same invocations, side by side: the emulator's REPORT
# (duration and billed milliseconds are real measurements; Max Memory Used
# is the configured-size echo explained above), the container's cgroup peak
# (the genuine max-memory number, the one an actual Lambda would have put in
# the REPORT), and the patch's in-process wall time and RSS — then each
# delivery's cost measured against its own uninstrumented control.
{
  echo "### Hono on Lambda — \`$image\` ($platform)"
  echo
  echo '| accounting | line |'
  echo '| ---------- | ---- |'
  printf '| baseline (no instrumentation) REPORT | `%s` |\n' "$(printf '%s\n' "$baseline_logs" | grep 'REPORT RequestId' | head -1 | tr '\t' ' ')"
  printf '%s\n' "$logs" | grep 'REPORT RequestId' | tr '\t' ' ' | while IFS= read -r line; do
    printf '| runtime hook REPORT | `%s` |\n' "$line"
  done
  printf '| container cgroup peak | `%s` |\n' "$peak"
  printf '%s\n' "$logs" | grep 'invocation = ' | while IFS= read -r line; do
    printf '| runtime hook in-process | `%s` |\n' "$line"
  done
  printf '%s\n' "$consumer_logs" | grep 'REPORT RequestId' | tr '\t' ' ' | while IFS= read -r line; do
    printf '| SQS consumer REPORT | `%s` |\n' "$line"
  done
  printf '%s\n' "$consumer_logs" | grep 'invocation = ' | while IFS= read -r line; do
    printf '| SQS consumer in-process | `%s` |\n' "$line"
  done
  printf '| plain bundle REPORT | `%s` |\n' "$(printf '%s\n' "$plain_logs" | grep 'REPORT RequestId' | head -1 | tr '\t' ' ')"
  printf '%s\n' "$built_logs" | grep 'REPORT RequestId' | tr '\t' ' ' | while IFS= read -r line; do
    printf '| patched bundle REPORT | `%s` |\n' "$line"
  done
  printf '%s\n' "$built_logs" | grep 'invocation = ' | while IFS= read -r line; do
    printf '| patched bundle in-process | `%s` |\n' "$line"
  done
  echo
  echo "**Delivery cost, within each artifact (billed cold start, live from this run):**"
  echo
  echo "- unbundled: no instrumentation ${baseline_cold:-?} ms → runtime hook ${hook_cold:-?} ms (**hook cost $(delta "${baseline_cold:-}" "${hook_cold:-}")**)"
  echo "- bundled: no patches ${plain_cold:-?} ms → patches baked ${built_cold:-?} ms (**unplugin cost $(delta "${plain_cold:-}" "${built_cold:-}")**)"
  echo
  echo "The deliveries are not substitutes: bundling erases the module boundaries the runtime hook's package entries match, and an unbundled deployment gives the unplugin no build to ride. The bundled-vs-unbundled gap itself is the packaging choice, not an instrumentation cost."
  echo
  echo "_Committed reference measurement (five emulator boots per leg, oxc + acorn + orchestrion — see [coldStartTable.md](https://github.com/${GITHUB_REPOSITORY:-filipkunc/wrap-esm-lambda}/blob/${HEAD_SHA:-main}/examples/hono-lambda/coldStartTable.md)); the rows above are this run:_"
  echo
  if [ -n "${HEAD_SHA:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
    echo "![Cold start by deployment and mechanism — committed reference measurement](https://raw.githubusercontent.com/$GITHUB_REPOSITORY/$HEAD_SHA/examples/hono-lambda/coldStartChart.svg)"
    echo
  fi
} >> "$summary"

# Hand the numbers to the workflow, so a later step can put the same story
# on the PR conversation page.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "baseline_cold=${baseline_cold:-}"
    echo "hook_cold=${hook_cold:-}"
    echo "plain_cold=${plain_cold:-}"
    echo "built_cold=${built_cold:-}"
  } >> "$GITHUB_OUTPUT"
fi
