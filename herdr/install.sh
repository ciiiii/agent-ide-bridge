#!/usr/bin/env bash
# Plugin build step — herdr runs this on `herdr plugin install` (NOT on `plugin link`,
# where you build the working tree yourself with `npm run build`).
#
# Fetch the prebuilt claude-diff bundle from the latest GitHub release so install needs
# no toolchain (curl + node only). Fall back to a local npm build when the download
# isn't available (offline, or no release has shipped the asset yet). Either way the
# result lands at dist/cli.js, which viewer.sh runs.
set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/dist/cli.js"
url="${AIB_DIFF_URL:-https://github.com/ciiiii/agent-ide-bridge/releases/latest/download/claude-diff}"

mkdir -p "$root/dist"

echo "claude-diff: fetching prebuilt bundle ($url)"
if command -v curl >/dev/null 2>&1 &&
  curl -fsSL "$url" -o "$dest" 2>/dev/null &&
  [ -s "$dest" ] &&
  node --check "$dest" 2>/dev/null; then
  echo "claude-diff: installed prebuilt bundle -> dist/cli.js"
  exit 0
fi

echo "claude-diff: prebuilt unavailable; building from source (npm)"
cd "$root"
npm ci
npm run build
