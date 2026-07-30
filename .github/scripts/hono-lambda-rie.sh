#!/bin/sh
# Boot the hono-lambda example on the real Lambda runtime image and answer
# the example's events through the runtime interface emulator — the two API
# Gateway events against app.handler, then the SQS batch against
# consumer.handler in a second container (one container boots one handler).
# Read the platform's own accounting — the REPORT line's duration, billed
# milliseconds and memory — back off the container logs, next to the patch's
# in-process numbers. Every layer of the example's config must have spoken
# in the logs or the script fails. Usage:
#   hono-lambda-rie.sh <image> <platform> [summary-file]
set -eu
image=$1
platform=$2
summary=${3:-/dev/null}

workspace=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
example="$workspace/examples/hono-lambda"
name_app=ric-hono
name_consumer=ric-hono-consumer
port_app=9103
port_consumer=9104

cleanup() { docker rm -f "$name_app" "$name_consumer" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

boot() {
  docker run -d --name "$1" \
    --platform "$platform" \
    -p "$2:8080" \
    -v "$workspace:$workspace" \
    -w "$example" \
    -e LAMBDA_TASK_ROOT="$example" \
    -e AWS_LAMBDA_FUNCTION_MEMORY_SIZE=512 \
    -e NODE_OPTIONS="--import @wrap-esm-lambda/hooks/register" \
    -e WRAP_ESM_LAMBDA_CONFIG="$example/wrap.config.mjs" \
    -e WRAP_ESM_LAMBDA_ENGINE="${WRAP_ESM_LAMBDA_ENGINE:-oxc}" \
    "$image" "$3" >/dev/null
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

boot "$name_app" "$port_app" app.handler
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

boot "$name_consumer" "$port_consumer" consumer.handler
sqs=$(invoke "$port_consumer" sqs-batch)

# The handler's body arrives JSON-escaped inside the invocation envelope
# ({\"stored\":\"7\"}), so quoted-key needles can never match there — assert
# on quote-free body fragments and the envelope's own unescaped statusCode.
# The consumer has no envelope: a direct invocation returns the handler's
# own JSON, so its keys match unescaped.
ok=1
case "$get" in *'Simplicity is prerequisite for reliability.'*) ;; *) echo 'GET body missing the quote'; ok=0 ;; esac
case "$get" in *'"statusCode":200'*) ;; *) echo 'GET did not return 200'; ok=0 ;; esac
case "$post" in *stored*) ;; *) echo 'POST body missing stored'; ok=0 ;; esac
case "$post" in *'"statusCode":201'*) ;; *) echo 'POST did not return 201'; ok=0 ;; esac
case "$sqs" in *'"batchItemFailures"'*) ;; *) echo 'SQS response missing the partial-batch contract'; ok=0 ;; esac
case "$sqs" in *broken-3*) ;; *) echo 'SQS response missing the malformed record redrive'; ok=0 ;; esac

logs=$(docker logs "$name_app" 2>&1)
consumer_logs=$(docker logs "$name_consumer" 2>&1)

# every layer must have spoken: the route template from the hono entry, the
# SDK operations from the smithy entry (no network, no LocalStack — S3 under
# the HTTP handler, SNS under the SQS consumer), and the in-process timing
# from the _HANDLER-derived entry on both handler shapes
for needle in \
  'http.route = GET /quotes/:id -> 200' \
  'http.route = POST /quotes -> 201' \
  'aws.operation = PutObjectCommand' \
  'invocation = '; do
  case "$logs" in *"$needle"*) ;; *) echo "missing from app logs: $needle"; ok=0 ;; esac
done
for needle in \
  'aws.operation = PublishCommand' \
  'invocation = '; do
  case "$consumer_logs" in *"$needle"*) ;; *) echo "missing from consumer logs: $needle"; ok=0 ;; esac
done

if [ "$ok" -ne 1 ]; then
  echo "GET  -> ${get:-<no response>}"
  echo "POST -> ${post:-<no response>}"
  echo "SQS  -> ${sqs:-<no response>}"
  echo '--- app container logs ---'
  printf '%s\n' "$logs"
  echo '--- consumer container logs ---'
  printf '%s\n' "$consumer_logs"
  exit 1
fi

echo "GET  -> $get"
echo "POST -> $post"
echo "SQS  -> $sqs"
echo "container cgroup peak: $peak"
printf '%s\n%s\n' "$logs" "$consumer_logs" |
  grep -E 'REPORT|invocation = |http\.route = |aws\.operation = ' || true

# Three views of the same invocations, side by side: the emulator's REPORT
# (duration and billed milliseconds are real measurements; Max Memory Used
# is the configured-size echo explained above), the container's cgroup peak
# (the genuine max-memory number, the one an actual Lambda would have put in
# the REPORT), and the patch's in-process wall time and RSS.
{
  echo "### Hono on Lambda — \`$image\` ($platform)"
  echo
  echo '| accounting | line |'
  echo '| ---------- | ---- |'
  printf '%s\n' "$logs" | grep 'REPORT RequestId' | tr '\t' ' ' | while IFS= read -r line; do
    printf '| platform REPORT | `%s` |\n' "$line"
  done
  printf '| container cgroup peak | `%s` |\n' "$peak"
  printf '%s\n' "$logs" | grep 'invocation = ' | while IFS= read -r line; do
    printf '| in-process | `%s` |\n' "$line"
  done
  printf '%s\n' "$consumer_logs" | grep 'REPORT RequestId' | tr '\t' ' ' | while IFS= read -r line; do
    printf '| SQS consumer REPORT | `%s` |\n' "$line"
  done
  printf '%s\n' "$consumer_logs" | grep 'invocation = ' | while IFS= read -r line; do
    printf '| SQS consumer in-process | `%s` |\n' "$line"
  done
  echo
} >> "$summary"
