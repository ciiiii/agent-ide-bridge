#!/usr/bin/env bash
# Launch the claude-diff CLI inside a herdr pane.
#
# herdr starts pane commands with a MINIMAL PATH, so a bare `node` often isn't found
# (here node is managed by mise). lib.sh restores PATH and computes a deterministic
# per-workspace port. Runs with the agent's cwd, so it finds itself and the bundle
# via $HERDR_PLUGIN_ROOT.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
aib_fix_path

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "claude-diff: 'node' not found under herdr's minimal PATH." >&2
  echo "Add its dir to PATH in herdr/lib.sh (e.g. your mise/nvm/fnm/asdf shims)." >&2
  sleep 30 # keep the pane open so this message is readable
  exit 127
fi

# The CLI exits itself ~AIB_IDLE_EXIT seconds after the agent disconnects (0 = never).
# AIB_DIFF_VIEW picks the view diffs open in (line|word); `w` toggles it in the pager.
"$NODE" "$HERDR_PLUGIN_ROOT/dist/cli.js" \
  --port "$(aib_ws_port)" \
  --ide-name claude-diff \
  --idle-exit "${AIB_IDLE_EXIT:-5}" \
  --diff-view "${AIB_DIFF_VIEW:-line}"
rc=$?

# herdr may keep a pane open on process exit, so close our own pane to make
# auto-close reliable. Only on a clean exit — a crash stays visible for debugging.
if [ "$rc" = 0 ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  "${HERDR_BIN_PATH:-herdr}" pane close "$HERDR_PANE_ID" >/dev/null 2>&1 || true
fi
exit "$rc"
