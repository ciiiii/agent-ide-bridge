#!/usr/bin/env bash
# claude: start with diff viewer — open the viewer beside THIS pane and launch
# claude here already connected (CLAUDE_CODE_SSE_PORT set), so no separate toggle
# or /ide is needed. Invoke from the pane where you want claude to run.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
aib_fix_path
H="${HERDR_BIN_PATH:-herdr}"

die() {
  printf 'claude-diff: %s\n' "$1" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || die "jq is required"

pane="${HERDR_PANE_ID:-}"
[ -n "$pane" ] || die "run this from inside a shell pane (no HERDR_PANE_ID)"

# 0) Pick the action from the pane's state. Launching claude only makes sense on an
#    idle pane: `herdr pane run` writes to the pane regardless of what holds it, so on
#    a busy pane the launch line would be typed into that process (a live claude
#    prompt, a pager, an editor). There the key degrades to the viewer toggle — the
#    session already running connects to it with /ide.
#    The viewer pane itself is the sharpest case: it has no shell, so it *looks* idle
#    (its foreground group is its own process group) and the launch line would land in
#    the CLI. Check it before the idle test.
if aib_is_viewer "$pane"; then
  printf 'claude-diff: focused on the viewer — toggling it\n'
  exec bash "$here/pane.sh" toggle
fi

running="$(aib_pane_running "$pane")"
if [ -n "$running" ]; then
  printf 'claude-diff: pane is running %s — toggling the viewer only (connect it with /ide)\n' "$running"
  exec bash "$here/pane.sh" toggle
fi

# 1) Open the viewer beside this pane (idempotent — no-op if already open).
bash "$here/pane.sh" open || true

# 2) Find the viewer's port. It binds a deterministic per-workspace port
#    (aib_ws_port); prefer that lock, then fall back to the newest claude-diff lock
#    in case a rare collision forced a random port.
ide_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
want="$(aib_ws_port)"
port=""
for _ in $(seq 1 30); do
  if [ -f "$ide_dir/$want.lock" ] &&
    [ "$(jq -r '.ideName // empty' "$ide_dir/$want.lock" 2>/dev/null)" = "claude-diff" ]; then
    port="$want"
    break
  fi
  sleep 0.2
done
if [ -z "$port" ]; then
  port=$(
    for f in $(ls -t "$ide_dir"/*.lock 2>/dev/null); do
      [ "$(jq -r '.ideName // empty' "$f" 2>/dev/null)" = "claude-diff" ] && {
        basename "$f" .lock
        break
      }
    done
  )
fi
[ -n "$port" ] || die "viewer did not come up (no claude-diff lock in $ide_dir)"

# 3) Launch claude in THIS pane, connected to the viewer. If `herdr pane run` isn't
#    the right verb on this herdr build, tell the user the exact command to run.
if ! "$H" pane run "$pane" "CLAUDE_CODE_SSE_PORT=$port claude" 2>/dev/null; then
  die "couldn't auto-launch claude — run this in the pane:  CLAUDE_CODE_SSE_PORT=$port claude"
fi
printf 'claude-diff: viewer on port %s; launched claude in %s\n' "$port" "$pane"
