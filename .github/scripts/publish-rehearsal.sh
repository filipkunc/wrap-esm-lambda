#!/bin/sh
# A full-dress rehearsal of the npm publish, against a registry only this
# machine can see. The public registry has no draft state — a published
# version is live and its number is burned forever — so the way to check a
# release before anyone can install it is to publish it somewhere private
# and install it back. Verdaccio is that somewhere: the real `pnpm publish
# -r` flow for the workspace packages, a real platform-package publish for
# the native addon, and then a scratch consumer that installs everything
# from the rehearsal registry and runs the runtime hook end to end — the
# exact failure surface (dependency resolution between the packages, the
# napi optionalDependencies dance, bin links, exports maps) that dry runs
# and tarball tests cannot reach.
#
# What this deliberately does NOT rehearse: `napi prepublish` itself (it
# orchestrates all nine platform packages from CI's downloaded artifacts;
# locally only the host's binary exists, so its platform package is
# published directly and the root goes out with --ignore-scripts), and npm
# provenance (a registry.npmjs.org feature). Everything else is the real
# flow.
#
# Usage: pnpm publish:rehearsal   (requires a prior `pnpm build` for the
# host platform's .node binary, and network to npmjs for verdaccio itself
# and the packages' external dependencies)
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
port=${REHEARSAL_PORT:-4874}
registry="http://localhost:$port"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/wrap-esm-lambda-rehearsal-XXXXXX")
verdaccio_pid=''

# killing the npx wrapper alone orphans the actual server, and verdaccio
# retitles its process to a bare "verdaccio" (argv is gone, so no pattern
# with the port can match) — cleanup therefore kills the tracked PID and
# every process EXACTLY named verdaccio. Tradeoff: a rehearsal ends any
# other local verdaccio too; run it elsewhere if that matters.
stop_verdaccio() {
  [ -n "$verdaccio_pid" ] && kill "$verdaccio_pid" 2>/dev/null || true
  pkill -x verdaccio 2>/dev/null || true
}
cleanup() {
  stop_verdaccio
  rm -rf "$scratch" "$repo/npm"
}
trap cleanup EXIT

if curl -sf "http://localhost:$port/-/ping" > /dev/null 2>&1; then
  echo "something already answers on port $port — killing stale rehearsal registries"
  pkill -x verdaccio 2>/dev/null || true
  sleep 1
  curl -sf "http://localhost:$port/-/ping" > /dev/null 2>&1 && {
    echo "port $port is still taken by something that is not ours — set REHEARSAL_PORT" >&2
    exit 1
  }
fi

binaries=$(cd "$repo" && ls wrap-esm-lambda.*.node 2>/dev/null || true)
if [ -z "$binaries" ]; then
  echo 'no wrap-esm-lambda.*.node in the repo root — run `pnpm build` first' >&2
  exit 1
fi

# --- the registry: scratch storage, anonymous publish for our names only,
# everything else proxied to npmjs so the packages' real dependencies
# resolve during the consumer install
cat > "$scratch/verdaccio.yaml" << EOF
storage: $scratch/storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@wrap-esm-lambda/*':
    access: \$all
    publish: \$all
  'wrap-esm-lambda*':
    access: \$all
    publish: \$all
  '**':
    access: \$all
    proxy: npmjs
log: { type: stdout, level: warn }
EOF

echo "starting verdaccio on $registry ..."
(cd "$scratch" && npx --yes verdaccio --config "$scratch/verdaccio.yaml" --listen "$port" > "$scratch/verdaccio.log" 2>&1) &
verdaccio_pid=$!
for _ in $(seq 1 60); do
  curl -sf "$registry/-/ping" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$registry/-/ping" > /dev/null || { echo 'verdaccio did not come up:' >&2; cat "$scratch/verdaccio.log" >&2; exit 1; }

# npm and pnpm both refuse to publish without a token, even to a registry
# that accepts anonymous publishes — a fake one satisfies the client
cat > "$scratch/npmrc" << EOF
registry=$registry
//localhost:$port/:_authToken=rehearsal
EOF
export NPM_CONFIG_USERCONFIG="$scratch/npmrc"
# both clients cache registry metadata and tarballs by URL; a rerun against
# a fresh registry on the same port must not be answered from a previous
# run's cache, so the caches live in scratch too
export npm_config_cache="$scratch/npm-cache"

# --- publish, the same shapes the CI publish job runs
echo 'publishing workspace packages (pnpm publish -r) ...'
(cd "$repo" && pnpm publish -r --force --access public --no-git-checks --filter './packages/*' --registry "$registry")

# package.json's publishConfig.registry pins the real npmjs — correct for
# the real release, and it outranks every other registry setting at publish
# time, so the rehearsal rewrites it in the PACKED COPIES only (the repo
# files are never touched): the platform dirs are generated anyway, and the
# root goes through `npm pack` into scratch first.
point_at_rehearsal() {
  node -e '
    const fs = require("node:fs")
    const path = process.argv[1]
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"))
    pkg.publishConfig = { ...pkg.publishConfig, registry: process.argv[2] }
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2))
  ' "$1" "$registry"
}

echo 'publishing the host platform package ...'
(cd "$repo" && pnpm exec napi create-npm-dirs)
for binary in $binaries; do
  suffix=${binary#wrap-esm-lambda.}
  suffix=${suffix%.node}
  [ -d "$repo/npm/$suffix" ] || { echo "no npm/$suffix dir for $binary" >&2; exit 1; }
  cp "$repo/$binary" "$repo/npm/$suffix/"
  point_at_rehearsal "$repo/npm/$suffix/package.json"
  (cd "$repo/npm/$suffix" && npm publish --access public)
done

# --ignore-scripts skips prepublishOnly's `napi prepublish`, which wants all
# nine platform artifacts; the host's platform package just went out above,
# and missing optionalDependencies are non-fatal at install time. The pack →
# extract → publish detour exists so publishConfig can be repointed without
# editing the repo's package.json.
echo 'publishing the root addon package ...'
root_pack=$(cd "$repo" && npm pack --pack-destination "$scratch" 2>/dev/null | tail -1)
mkdir -p "$scratch/root-pkg"
tar -xzf "$scratch/$root_pack" -C "$scratch/root-pkg" --strip-components=1
point_at_rehearsal "$scratch/root-pkg/package.json"
# Two more things `napi prepublish` would have done or made irrelevant:
# it INJECTS the per-platform optionalDependencies into the published
# manifest (the repo's package.json deliberately has none — the rehearsal
# caught this by installing a root package that could not find its
# binding), and its absence means publisher-side lifecycle must go too
# (registry consumers never run prepare, and npm runs the pack lifecycle
# even under --ignore-scripts, which fails here because the extracted copy
# has no devDependencies for husky).
suffixes=$(for binary in $binaries; do s=${binary#wrap-esm-lambda.}; printf '%s ' "${s%.node}"; done)
node -e '
  const fs = require("node:fs")
  const path = process.argv[1]
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"))
  delete pkg.scripts
  pkg.optionalDependencies = { ...pkg.optionalDependencies }
  for (const suffix of process.argv[2].trim().split(/\s+/)) {
    pkg.optionalDependencies[`wrap-esm-lambda-${suffix}`] = pkg.version
  }
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2))
' "$scratch/root-pkg/package.json" "$suffixes"
(cd "$scratch/root-pkg" && npm publish --access public --ignore-scripts)

# --- the consumer: a scratch project that knows nothing about the repo,
# installing from the rehearsal registry and running the README quick-start
# shape through the RUNTIME hook — installed hooks, installed core,
# installed root addon resolving its installed platform package
echo 'installing into a scratch consumer ...'
consumer="$scratch/consumer"
mkdir -p "$consumer/patches"
cat > "$consumer/package.json" << 'EOF'
{ "name": "rehearsal-consumer", "private": true, "type": "module" }
EOF
cat > "$consumer/app.mjs" << 'EOF'
export const greet = (name) => `hi:${name}`
EOF
cat > "$consumer/main.mjs" << 'EOF'
import { greet } from './app.mjs'
console.log(greet('rehearsal'))
EOF
cat > "$consumer/wrap.config.mjs" << 'EOF'
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'
// module.path candidates match absolutely or as suffixes — definePatches
// resolves patch.from, not these — so the config builds the absolute path
export default definePatches(
  [
    {
      module: { path: [fileURLToPath(new URL('./app.mjs', import.meta.url))] },
      patch: { name: 'wrapGreet', from: './patches/greet.mjs' },
      bindings: ['greet'],
    },
  ],
  import.meta.url,
)
EOF
cat > "$consumer/patches/greet.mjs" << 'EOF'
export function wrapGreet(bindings) {
  const original = bindings.greet
  bindings.greet = (name) => `patched:${original(name)}`
}
EOF
(cd "$consumer" && npm install wrap-esm-lambda @wrap-esm-lambda/core @wrap-esm-lambda/hooks @wrap-esm-lambda/unplugin > /dev/null)

echo 'smoke: native addon through the installed platform package ...'
(cd "$consumer" && node -e '
const { exportsTap } = require("wrap-esm-lambda")
if (typeof exportsTap !== "function") throw new Error("native exportsTap missing")
console.log("native binding resolves and loads from the registry install")')

echo 'smoke: unplugin surface loads ...'
(cd "$consumer" && node -e 'import("@wrap-esm-lambda/unplugin").then((m) => {
  if (typeof m.esbuildPlugin !== "function") throw new Error("esbuildPlugin missing")
  console.log("unplugin surface loads from the registry install")
})')

echo 'smoke: runtime hook end to end, oxc engine, installed packages only ...'
out=$(cd "$consumer" && WRAP_ESM_LAMBDA_ENGINE=oxc WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs \
  node --import @wrap-esm-lambda/hooks/register main.mjs)
if [ "$out" != "patched:hi:rehearsal" ]; then
  echo "unexpected runtime-hook output: $out" >&2
  exit 1
fi
echo "runtime hook patched the consumer app: $out"

echo
echo 'rehearsal PASSED — the publish flow, the package layout and the install'
echo 'experience all work against a registry no one else can see.'
