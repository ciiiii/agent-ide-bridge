# Shared helpers for the agent-ide-bridge herdr plugin scripts. Sourced, not run.

# herdr runs plugin commands with a MINIMAL PATH; restore common tool dirs so
# node/jq resolve (this box uses mise, whose shims live under ~/.local/share/mise/shims).
aib_fix_path() {
  export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
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
