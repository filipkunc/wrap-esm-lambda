#!/bin/sh
# docker pull with retries and backoff. Registry hiccups — a TLS handshake
# timeout at Docker Hub, a slow ECR edge — are the one CI flake left now that
# everything else is pinned, and an unretried implicit pull inside
# `docker run` turns thirty seconds of registry weather into a red lane.
# Deliberately no `set -e`: the retry loop IS the error handling.
set -u
image=$1
platform=${2:-}

attempt=1
while [ "$attempt" -le 4 ]; do
  if [ -n "$platform" ]; then
    docker pull --quiet --platform "$platform" "$image" && exit 0
  else
    docker pull --quiet "$image" && exit 0
  fi
  if [ "$attempt" -lt 4 ]; then
    echo "docker pull attempt $attempt failed for $image, retrying in $((attempt * 10))s..."
    sleep $((attempt * 10))
  fi
  attempt=$((attempt + 1))
done

echo "docker pull failed after 4 attempts: $image" >&2
exit 1
