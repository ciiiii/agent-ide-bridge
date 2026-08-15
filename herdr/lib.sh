# Shared helpers for the agent-ide-bridge herdr plugin scripts. Sourced, not run.

# herdr runs plugin commands with a MINIMAL PATH; restore common tool dirs so
# node/jq resolve (this box uses mise, whose shims live under ~/.local/share/mise/shims).
aib_fix_path() {
  export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
}

# Name of the command running in a pane's foreground, or nothing when the pane sits
# at its shell prompt. A pane is idle exactly when its foreground process group IS the
# shell; the foreground_processes list alone is not a signal (an idle pane still shows
# transient children like a prompt hook's `git`). Unknown/unreadable panes read idle.
# Usage: running="$(aib_pane_running "$pane_id")"
aib_pane_running() {
  local info fg
  info=$("${HERDR_BIN_PATH:-herdr}" pane process-info --pane "$1" 2>/dev/null) || return 0
  fg=$(printf '%s' "$info" | jq -r '
    .result.process_info
    | select((.shell_pid // empty) and (.foreground_process_group_id // empty))
    | select(.foreground_process_group_id != .shell_pid)
    | .foreground_process_group_id // empty' 2>/dev/null)
  [ -n "$fg" ] || return 0
  printf '%s' "$info" | jq -r --arg g "$fg" '
    [.result.process_info.foreground_processes[]? | select((.pid | tostring) == $g) | .argv0 // .name]
    | first // "a command"' 2>/dev/null
}

# Deterministic per-workspace viewer port, so concurrent spaces don't collide on
# one port (which would cause EADDRINUSE + a random fallback). viewer.sh binds it
# and start.sh hands it to claude — same input, same port. Override with
# AIB_DIFF_PORT. Range 9000..9499 (skips the code-server bridge's 8990/8991).
aib_ws_port() {
  if [ -n "${AIB_DIFF_PORT:-}" ]; then
    printf '%s' "$AIB_DIFF_PORT"
    return
  fi
  id="${HERDR_WORKSPACE_ID:-default}"
  n=$(printf '%s' "$id" | tr -cd '0-9')
  if [ -n "$n" ]; then
    printf '%s' "$((9000 + (10#$n % 500)))"
  else
    printf '%s' "$((9000 + $(printf '%s' "$id" | cksum | awk '{print $1 % 500}')))"
  fi
}
