#!/bin/sh
# Boot the hono-lambda example on the real Lambda runtime image, answer the
# example's two API Gateway events through the runtime interface emulator,
# and read the platform's own accounting — the REPORT line's duration,
# billed milliseconds and memory — back off the container logs, next to the
# patch's in-process numbers. Every layer of the example's config must have
# spoken in the logs or the script fails. Usage:
#   hono-lambda-rie.sh <image> <platform> [summary-file]
set -eu
image=$1
platform=$2
summary=${3:-/dev/null}

workspace=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
example="$workspace/examples/hono-lambda"
name=ric-hono
port=9103

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$name" \
  --platform "$platform" \
  -p "$port:8080" \
  -v "$workspace:$workspace" \
  -w "$example" \
  -e LAMBDA_TASK_ROOT="$example" \
  -e AWS_LAMBDA_FUNCTION_MEMORY_SIZE=512 \
  -e NODE_OPTIONS="--import @wrap-esm-lambda/hooks/register" \
  -e WRAP_ESM_LAMBDA_CONFIG="$example/wrap.config.mjs" \
  -e WRAP_ESM_LAMBDA_ENGINE="${WRAP_ESM_LAMBDA_ENGINE:-oxc}" \
  "$image" app.handler >/dev/null

invoke() {
  event=$1
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

get=$(invoke get-quote)
post=$(invoke post-quote)

ok=1
case "$get" in *'Simplicity is prerequisite for reliability.'*) ;; *) ok=0 ;; esac
case "$post" in *'"stored":"7"'*) ;; *) ok=0 ;; esac

logs=$(docker logs "$name" 2>&1)

# every layer must have spoken: the route template from the hono entry, the
# SDK operation from the smithy entry (no network, no LocalStack), and the
# in-process timing from the _HANDLER-derived entry
for needle in \
  'http.route = GET /quotes/:id -> 200' \
  'http.route = POST /quotes -> 201' \
  'aws.operation = PutObjectCommand' \
  'invocation = '; do
  case "$logs" in *"$needle"*) ;; *) echo "missing from logs: $needle"; ok=0 ;; esac
done

if [ "$ok" -ne 1 ]; then
  echo "GET  -> ${get:-<no response>}"
  echo "POST -> ${post:-<no response>}"
  echo '--- container logs ---'
  printf '%s\n' "$logs"
  exit 1
fi

echo "GET  -> $get"
echo "POST -> $post"
printf '%s\n' "$logs" | grep -E 'REPORT|invocation = |http\.route = |aws\.operation = ' || true

# The two views of the same invocations, side by side. The REPORT duration
# and billed milliseconds are the emulator's real measurements; its "Max
# Memory Used" merely echoes the configured size (the emulator does not
# meter memory — an actual Lambda does), which is exactly why the patch's
# in-process RSS line is worth having.
{
  echo "### Hono on Lambda — \`$image\` ($platform)"
  echo
  echo '| accounting | line |'
  echo '| ---------- | ---- |'
  printf '%s\n' "$logs" | grep 'REPORT RequestId' | tr '\t' ' ' | while IFS= read -r line; do
    printf '| platform REPORT | `%s` |\n' "$line"
  done
  printf '%s\n' "$logs" | grep 'invocation = ' | while IFS= read -r line; do
    printf '| in-process | `%s` |\n' "$line"
  done
  echo
} >> "$summary"
