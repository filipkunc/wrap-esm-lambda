#!/bin/bash
set -euo pipefail

# Claude Code on the web only: local checkouts manage their own toolchain
# (README, "Building and running locally").
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# corepack fetches the pnpm version pinned in package.json; pre-authorise the
# download so the install cannot block on an invisible prompt (the same
# reason every .vscode/tasks.json task sets this).
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

pnpm install

# rust-toolchain.toml pins the MSRV. Install it explicitly up front: the
# container may ship an older stable (one that fails the `rust-version`
# floor), and paying the toolchain download inside `pnpm build` would make
# a build failure out of what is really a setup step.
rustup toolchain install

# The README's "required once after cloning" steps: the release addon plus
# the generated index.js/index.d.ts glue (gitignored, so a fresh clone has
# neither), then the workspace packages the test suite imports.
pnpm build
pnpm build:packages
