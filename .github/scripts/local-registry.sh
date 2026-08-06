#!/bin/sh
# A local npm registry that STAYS UP between commands, so a consumer project
# can be installed into, broken, reinstalled and poked at by hand. That loop
# is the one thing `publish:rehearsal` cannot give you: it is a single
# hermetic pass that tears its registry down on exit, which is exactly right
# for verifying a release and exactly wrong for exploring one.
#
# The publish flow itself is the rehearsal's, and the reasons behind its odd
# parts are documented at length in publish-rehearsal.sh: `pnpm publish -r`
# for the workspace packages, a real platform-package publish per built
# .node, and the root addon packed → repointed → republished with the
# optionalDependencies `napi prepublish` would have injected. What differs is
# everything around it — the storage is persistent, publishing over a version
# that is already there works, and the server outlives the script.
#
# Usage:
#   local-registry.sh up        start the registry (idempotent)
#   local-registry.sh publish   (re)publish everything; starts the registry if down
#   local-registry.sh smoke     install into a throwaway consumer, check it works
#   local-registry.sh status    what is running, what is published
#   local-registry.sh down      stop it ( --clean also wipes what was published )
#
# Needs a prior `pnpm build` — or `pnpm build:debug`, unlike the rehearsal:
# the body limit below is raised past the ~60MB an unstripped debug .node
# reaches, which the 10mb default rejects with a bare E413.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
state=${LOCAL_REGISTRY_HOME:-$repo/.local-registry}
port=${LOCAL_REGISTRY_PORT:-4875}
registry="http://localhost:$port"

# 4873 is verdaccio's own default and 4874 is the rehearsal's, so the default
# here is a third port: this registry is meant to sit alongside whatever else
# you already run, not fight it for a socket.

up_already() { curl -sf "$registry/-/ping" > /dev/null 2>&1; }

# Ownership is decided by the LISTENING SOCKET, not by process name — a
# running verdaccio retitles itself to a bare "verdaccio" with no argv left,
# so `pkill -x verdaccio` (what the rehearsal must resort to) would also kill
# an unrelated instance on another port. Ours is whoever holds our port.
pid_on_port() {
  pid=$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p' | head -1)
  [ -n "$pid" ] || pid=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -n "$pid" ] || return 1
  printf '%s\n' "$pid"
}

write_config() {
  mkdir -p "$state"
  # Rewritten on every `up` so config fixes land without anyone remembering
  # to delete a stale file. Two departures from verdaccio's default config,
  # both of which this project trips over:
  #
  #  - our own names get proxy-less blocks with `publish: $all`. The default
  #    config proxies EVERY pattern to npmjs and demands $authenticated, so
  #    publishing 0.3.0 locally collides with whatever 0.3.0 npmjs already
  #    knows about (EPUBLISHCONFLICT) and refuses anonymous tokens first.
  #  - `unpublish: $all`, because storage here is persistent: republishing a
  #    version means retracting it first, and that has to be allowed.
  cat > "$state/config.yaml" << EOF
storage: $state/storage
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@wrap-esm-lambda/*':
    access: \$all
    publish: \$all
    unpublish: \$all
  'wrap-esm-lambda*':
    access: \$all
    publish: \$all
    unpublish: \$all
  '**':
    access: \$all
    proxy: npmjs
max_body_size: 250mb
log: { type: stdout, level: warn }
EOF
}

# npm and pnpm both refuse to publish without a token even to a registry that
# takes anonymous publishes, and a userconfig of our own means satisfying
# them never touches ~/.npmrc.
write_npmrc() {
  cat > "$state/npmrc" << EOF
registry=$registry
//localhost:$port/:_authToken=local-registry
EOF
}

cmd_up() {
  if up_already; then
    echo "already up on $registry"
    return 0
  fi
  write_config
  write_npmrc
  echo "starting verdaccio on $registry ..."
  # setsid detaches from this script's session, so the server survives the
  # shell that started it — the entire point of this script over the rehearsal
  setsid npx --yes verdaccio --config "$state/config.yaml" --listen "$port" \
    >> "$state/verdaccio.log" 2>&1 &
  for _ in $(seq 1 60); do
    up_already && break
    sleep 1
  done
  up_already || { echo 'verdaccio did not come up:' >&2; tail -20 "$state/verdaccio.log" >&2; exit 1; }
  echo "up. storage: $state/storage   log: $state/verdaccio.log"
}

cmd_down() {
  pid=$(pid_on_port || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      up_already || break
      sleep 1
    done
    echo "stopped (pid $pid)"
  else
    echo "nothing listening on port $port"
  fi
  if [ "${1:-}" = '--clean' ]; then
    rm -rf "$state/storage" "$state/consumer"
    echo "wiped $state/storage"
  fi
}

# The four workspace packages plus every name the addon publishes under, so
# a republish can retract first. Platform names follow the built binaries:
# only the host's exist locally, and that is all this registry ever serves.
published_names() {
  echo '@wrap-esm-lambda/core @wrap-esm-lambda/engine-acorn @wrap-esm-lambda/hooks @wrap-esm-lambda/unplugin wrap-esm-lambda'
  for suffix in $(host_suffixes); do echo "wrap-esm-lambda-$suffix"; done
}

host_suffixes() {
  for binary in $(cd "$repo" && ls wrap-esm-lambda.*.node 2>/dev/null || true); do
    suffix=${binary#wrap-esm-lambda.}
    printf '%s\n' "${suffix%.node}"
  done
}

# publishConfig.registry in package.json pins the real npmjs — correct for a
# real release, and it OUTRANKS --registry at publish time, so every manifest
# that goes out here has to be repointed first. Only ever applied to copies:
# the platform dirs are generated, and the root goes through `npm pack`.
point_here() {
  node -e '
    const fs = require("node:fs")
    const path = process.argv[1]
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"))
    pkg.publishConfig = { ...pkg.publishConfig, registry: process.argv[2] }
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2))
  ' "$1" "$registry"
}

cmd_publish() {
  suffixes=$(host_suffixes)
  [ -n "$suffixes" ] || { echo 'no wrap-esm-lambda.*.node in the repo root — run `pnpm build` first' >&2; exit 1; }

  up_already || cmd_up
  write_npmrc
  export NPM_CONFIG_USERCONFIG="$state/npmrc"

  # Persistent storage means the version being published is usually already
  # there. Retract first and the same version number can be iterated on all
  # afternoon; without this every second run is an EPUBLISHCONFLICT.
  echo 'retracting previous versions ...'
  for name in $(published_names); do
    npm unpublish "$name" --force --registry "$registry" > /dev/null 2>&1 || true
  done

  echo 'publishing workspace packages ...'
  (cd "$repo" && pnpm publish -r --force --access public --no-git-checks --filter './packages/*' --registry "$registry")

  echo 'publishing platform packages ...'
  (cd "$repo" && pnpm exec napi create-npm-dirs > /dev/null)
  for suffix in $suffixes; do
    [ -d "$repo/npm/$suffix" ] || { echo "no npm/$suffix dir for the built binary" >&2; exit 1; }
    cp "$repo/wrap-esm-lambda.$suffix.node" "$repo/npm/$suffix/"
    point_here "$repo/npm/$suffix/package.json"
    (cd "$repo/npm/$suffix" && npm publish --access public > /dev/null)
    echo "  wrap-esm-lambda-$suffix"
  done
  rm -rf "$repo/npm"

  # The pack → extract → publish detour is what lets publishConfig be
  # repointed without editing the repo's package.json. Two edits beyond that,
  # both standing in for `napi prepublish`, which cannot run on one host's
  # binary: it INJECTS the per-platform optionalDependencies into the
  # published manifest (the repo's package.json deliberately carries none, so
  # an installed root would find no binding without this), and dropping the
  # scripts takes out both prepublishOnly's `napi prepublish` and the husky
  # `prepare` that npm runs during pack even under --ignore-scripts.
  echo 'publishing the root addon package ...'
  rm -rf "$state/root"
  mkdir -p "$state/root"
  root_pack=$(cd "$repo" && npm pack --pack-destination "$state" 2>/dev/null | tail -1)
  tar -xzf "$state/$root_pack" -C "$state/root" --strip-components=1
  point_here "$state/root/package.json"
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
  ' "$state/root/package.json" "$(echo "$suffixes" | tr '\n' ' ')"
  (cd "$state/root" && npm publish --access public --ignore-scripts > /dev/null)
  rm -f "$state/$root_pack"
  echo "  wrap-esm-lambda"

  echo
  echo "published to $registry — install into a consumer with:"
  echo
  echo "  rm -rf node_modules package-lock.json"
  echo "  npm install wrap-esm-lambda @wrap-esm-lambda/hooks --registry $registry"
  echo
  echo "the lockfile has to go: a previous install recorded the native package"
  echo "as an absent optional dependency, and npm will not revisit that on its own."
}

cmd_status() {
  if up_already; then
    echo "up on $registry (pid $(pid_on_port || echo '?'))"
  else
    echo "down (nothing on port $port)"
  fi
  echo "storage: $state/storage"
  [ -d "$state/storage" ] || return 0
  node -e '
    const fs = require("node:fs"), path = require("node:path")
    const root = process.argv[1]
    const read = (dir) => {
      const manifest = path.join(dir, "package.json")
      if (!fs.existsSync(manifest)) return
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"))
      console.log(`  ${pkg.name}  ${Object.keys(pkg.versions ?? {}).join(", ")}`)
    }
    for (const entry of fs.readdirSync(root)) {
      if (!/^(@)?wrap-esm-lambda/.test(entry)) continue
      const dir = path.join(root, entry)
      if (entry.startsWith("@")) for (const sub of fs.readdirSync(dir)) read(path.join(dir, sub))
      else read(dir)
    }
  ' "$state/storage"
}

# A consumer that knows nothing about the repo: installed hooks, installed
# core, installed root addon resolving its installed platform package. Left
# on disk afterwards so it can be edited and rerun by hand.
cmd_smoke() {
  up_already || { echo "registry is down — run '$(basename "$0") up' first" >&2; exit 1; }
  consumer="$state/consumer"
  rm -rf "$consumer"
  mkdir -p "$consumer/patches"
  cat > "$consumer/package.json" << 'EOF'
{ "name": "local-registry-consumer", "private": true, "type": "module" }
EOF
  cat > "$consumer/app.mjs" << 'EOF'
export const greet = (name) => `hi:${name}`
EOF
  cat > "$consumer/main.mjs" << 'EOF'
import { greet } from './app.mjs'
console.log(greet('local'))
EOF
  # module.path candidates match absolutely or as suffixes — definePatches
  # resolves patch.from, not these — so the config builds the absolute path
  cat > "$consumer/wrap.config.mjs" << 'EOF'
import { fileURLToPath } from 'node:url'
import { definePatches } from '@wrap-esm-lambda/core'
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
  echo 'installing ...'
  (cd "$consumer" && npm install wrap-esm-lambda @wrap-esm-lambda/core @wrap-esm-lambda/hooks @wrap-esm-lambda/unplugin \
    --registry "$registry" > /dev/null)

  echo 'smoke: native addon through the installed platform package ...'
  (cd "$consumer" && node -e '
const { exportsTap } = require("wrap-esm-lambda")
if (typeof exportsTap !== "function") throw new Error("native exportsTap missing")
console.log("  native binding resolves from the registry install")')

  echo 'smoke: runtime hook end to end ...'
  out=$(cd "$consumer" && WRAP_ESM_LAMBDA_ENGINE=oxc WRAP_ESM_LAMBDA_CONFIG=./wrap.config.mjs \
    node --import @wrap-esm-lambda/hooks/register main.mjs)
  [ "$out" = 'patched:hi:local' ] || { echo "unexpected runtime-hook output: $out" >&2; exit 1; }
  echo "  runtime hook patched the consumer app: $out"
  echo
  echo "consumer left at $consumer"
}

case "${1:-}" in
  up) cmd_up ;;
  publish) cmd_publish ;;
  smoke) cmd_smoke ;;
  status) cmd_status ;;
  down) cmd_down "${2:-}" ;;
  *)
    sed -n '/^# Usage:/,/^#   local-registry.sh down/p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
