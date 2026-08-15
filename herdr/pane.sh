#!/usr/bin/env bash
# Open / close / toggle the claude-diff viewer pane beside the current agent.
#
#   pane.sh toggle     open a viewer pane, or close any open one
#   pane.sh open       open a viewer pane, no-op if one is open
#   pane.sh close      close the viewer pane(s), no-op if none
#   pane.sh auto-open  worktree.created event hook: open (gated by AIB_AUTO_OPEN=0)
#
# A "viewer pane" is any pane in this workspace whose foreground process is our CLI
# (node .../dist/cli.js), read live per pane — there is no state file. After opening,
# run `/ide` in the claude pane to connect it. The viewer auto-closes itself ~5s after
# the agent disconnects (CLI --idle-exit), so no close event is needed.
set -uo pipefail

# herdr runs plugin commands with a minimal PATH; restore common tool dirs.
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
aib_fix_path

mode="${1:-toggle}"
H="${HERDR_BIN_PATH:-herdr}"
PLUGIN="${HERDR_PLUGIN_ID:-cai.agent-ide-bridge}"
DIRECTION="${AIB_DIFF_DIRECTION:-right}" # split side for the viewer

# Events must never fail loudly (herdr logs them); explicit actions should.
refuse() {
  [ "$mode" = auto-open ] && exit 0
  printf 'claude-diff: %s\n' "$1" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || refuse "jq is required"

# auto-open takes its context from the event payload (no focused pane); explicit
# actions take it from the invocation context.
if [ "$mode" = auto-open ]; then
  [ "${AIB_AUTO_OPEN:-1}" = "0" ] && exit 0
  ev="${HERDR_PLUGIN_EVENT_JSON:-}"
  ws=$(printf '%s' "$ev" | jq -r '.data.workspace.workspace_id // .data.worktree.open_workspace_id // empty' 2>/dev/null)
  cwd=$(printf '%s' "$ev" | jq -r '.data.workspace.worktree.checkout_path // .data.worktree.path // empty' 2>/dev/null)
  pane=""
else
  ws="${HERDR_WORKSPACE_ID:-}"
  pane="${HERDR_PANE_ID:-}"
  cwd=""
  [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ] &&
    cwd=$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | jq -r '.focused_pane_cwd // .workspace_cwd // empty' 2>/dev/null)
fi
[ -n "$ws" ] || refuse "no workspace context (invoke from inside herdr)"

panes_json=$("$H" pane list --workspace "$ws" 2>/dev/null) &&
  printf '%s' "$panes_json" | jq -e '.result.panes' >/dev/null 2>&1 ||
  refuse "herdr pane list failed for $ws"

# A viewer pane runs `node .../dist/cli.js` in its foreground process group (aib_is_viewer).
existing=""
for p in $(printf '%s' "$panes_json" | jq -r '.result.panes[].pane_id // empty'); do
  aib_is_viewer "$p" && existing="$existing $p"
done

close_all() {
  for p in $existing; do "$H" pane close "$p" >/dev/null 2>&1; done
  printf 'claude-diff: closed%s in %s\n' "$existing" "$ws"
}

case "$mode" in
close)
  [ -n "$existing" ] && close_all || printf 'claude-diff: nothing open in %s\n' "$ws"
  exit 0
  ;;
toggle)
  [ -n "$existing" ] && {
    close_all
    exit 0
  }
  ;;
open | auto-open)
  [ -n "$existing" ] && {
    [ "$mode" = open ] && printf 'claude-diff: already open (%s) in %s\n' "$existing" "$ws"
    exit 0
  }
  ;;
*)
  refuse "unknown mode '$mode' (toggle | open | close | auto-open)"
  ;;
esac

# Open beside the focused pane (fall back to the workspace's first pane).
[ -n "$pane" ] || pane=$(printf '%s' "$panes_json" | jq -r '.result.panes[0].pane_id // empty')
[ -n "$pane" ] || refuse "no pane to attach to in $ws"

# The viewer's cwd = the agent's live cwd, so the CLI advertises the right repo for /ide.
[ -n "$cwd" ] ||
  cwd=$(printf '%s' "$panes_json" | jq -r --arg p "$pane" 'first(.result.panes[] | select(.pane_id == $p) | .foreground_cwd // empty)' 2>/dev/null)
[ -n "$cwd" ] || refuse "could not determine a cwd for the viewer"

open_json=$("$H" plugin pane open --plugin "$PLUGIN" --entrypoint diff \
  --placement split --target-pane "$pane" --direction "$DIRECTION" --cwd "$cwd" --no-focus 2>/dev/null)
new=$(printf '%s' "$open_json" | jq -r '.result.plugin_pane.pane.pane_id // empty' 2>/dev/null)
[ -n "$new" ] || refuse "herdr plugin pane open failed"
[ "$mode" = auto-open ] ||
  printf 'claude-diff: opened %s beside %s — now run /ide in the claude pane\n' "$new" "$pane"
