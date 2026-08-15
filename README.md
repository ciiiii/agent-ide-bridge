# Agent IDE Bridge

Bridges the **Claude Code IDE protocol** (MCP over WebSocket, discovered via
`~/.claude/ide/<port>.lock`) so Claude's **proposed diffs** (accept/reject in an
editor), selection context, and diagnostics reach a frontend — and lets **several
Claude sessions share one frontend** instead of fighting over the single slot.

Two frontends, three ways to run it — pick one:

- **[code-server / VS Code](#code-server--vs-code)** — several Claude sessions → one
  browser window, with in-editor diffs.
- **[herdr](#herdr)** — Claude in herdr panes → a `claude-diff` pane beside each
  agent, no browser.
- **[Standalone terminal](#standalone-terminal)** — `claude-diff` in any two
  terminals, no herdr, no browser.

## Why

By default only one Claude session can attach to a window at a time — two sessions
fight over the slot and only the newest gets diffs. This bridge keeps **all**
connected clients and multiplexes them onto one frontend.

---

## code-server / VS Code

Several Claude sessions share one code-server window with working in-editor diffs
(accept/reject), selection context, and diagnostics.

**Install** — grab the `.vsix` from the latest release:

```bash
curl -fsSL -o /tmp/aib.vsix \
  https://github.com/ciiiii/agent-ide-bridge/releases/latest/download/agent-ide-bridge.vsix \
  && code-server --install-extension /tmp/aib.vsix
code-server --uninstall-extension anthropic.claude-code   # avoid lockfile conflicts
# reload the window (or restart the code-server service)
```

(Or build from source: `npm run package` → `code-server --install-extension agent-ide-bridge.vsix`.)

**Use** — run `claude` in the window's integrated terminal (it auto-connects), or
run `/ide` from any terminal and pick this window. Accept / reject the focused diff
with `Cmd+Enter` / `Cmd+Backspace`.

---

## herdr

`claude-diff` runs in a herdr pane **beside the agent**, rendering Claude's proposed
diffs (through [`delta`](https://github.com/dandavison/delta) when present) in a
scrollable pager. Prereqs on the host: `node` ≥ 18 and `jq`; `delta` optional.

**Install** — fetches the prebuilt `claude-diff` from the release (curl + node, no
toolchain), falling back to an npm build if unavailable:

```bash
herdr plugin install ciiiii/agent-ide-bridge               # latest release
herdr plugin install ciiiii/agent-ide-bridge --ref v0.2.0  # pin a version
```

(Local dev: `herdr plugin link .` then `npm ci && npm run build` — `link` skips the build.)

**Use** — bind the one-step launcher in `~/.config/herdr/config.toml`, then
`herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+d"                        # ctrl+b then d
type = "plugin_action"
command = "cai.agent-ide-bridge.start"
description = "start claude + diff viewer"
```

`start` picks its action from the pane it runs in:

- **idle pane** → opens the viewer beside it and launches `claude` there already
  connected — no `/ide`.
- **busy pane** (claude already running, an editor, a build) → toggles the viewer
  only, and you connect the running session with `/ide`. It can't launch claude
  there: `herdr pane run` writes to the pane whatever holds it, so the launch line
  would be typed into that process.

So one key covers everything; `cai.agent-ide-bridge.{toggle,open,close}` stay available
as actions if you'd rather put the viewer on its own key.

- **Pager keys:** `j`/`k` line · `space`/`b` page · `g`/`G` ends · `w` line/word diff ·
  `y`/⏎ accept · `n`/esc reject.
- **Auto:** a viewer auto-opens for a new worktree (`worktree.created`; `AIB_AUTO_OPEN=0`
  to disable) and auto-closes ~5s after claude exits (`AIB_IDLE_EXIT` seconds, `0` = never).
- **Config:** `AIB_DIFF_PORT` (default: a stable per-workspace port), `AIB_DIFF_DIRECTION`
  (default `right`), `AIB_DIFF_VIEW` (`line`|`word`, default `line`).
- **Over `herdr --remote`:** keybindings resolve per `--remote-keybindings local|server` —
  put the binding on whichever side that selects.

---

## Standalone terminal

`claude-diff` in a plain terminal — no herdr, no browser. Grab the bundle (needs
`node` ≥ 18; `jq`/`delta` optional):

```bash
curl -fsSL -o claude-diff \
  https://github.com/ciiiii/agent-ide-bridge/releases/latest/download/claude-diff \
  && chmod +x claude-diff
```

Run it in one tab and `claude` in another:

```bash
./claude-diff --dir ~/your/project        # tab 1 — prints its port
cd ~/your/project
CLAUDE_CODE_SSE_PORT=<port> claude        # tab 2  (or run claude, then /ide)
```

Same pager keys as the [herdr setup](#herdr). `--diff-view word` (or `AIB_DIFF_VIEW=word`)
opens diffs in git's word-diff instead of delta's line diff — easier to read when a change
reflows a block across lines; `w` switches between them anytime.

---

## Architecture

The Claude adapter (the MCP-over-WS server) is frontend-agnostic: it drives an
`EditorFrontend`, of which there are two — VS Code and the terminal. Same protocol,
two surfaces.

```
src/
  core/
    types.ts         # neutral types + the EditorFrontend interface
    editorBridge.ts  # EditorFrontend #1 — VS Code diff tabs (the extension)
  adapters/
    claude/          # Claude IDE protocol: lockfile + MCP-over-WS server (no vscode)
      server.ts
      lockfile.ts
      protocol.ts
  cli/               # EditorFrontend #2 — terminal diff pager (claude-diff)
    index.ts
    terminalFrontend.ts
  extension.ts       # wires the VS Code frontend + adapter + accept/reject commands

herdr-plugin.toml    # herdr plugin: run the CLI in a pane beside the agent
herdr/               # pane.sh / start.sh / viewer.sh / lib.sh
```

`core/` and `adapters/claude/` know nothing about VS Code; the CLI reuses them verbatim.

## Build

```bash
npm install
npm run build          # -> dist/extension.js + dist/cli.js (esbuild bundles)
npm run package        # -> agent-ide-bridge.vsix
npm test               # e2e: drive the CLI over the Claude protocol (non-TTY path)
npm run test:tui       # e2e: the interactive pager, driven through a real pty
```

Releases (via release-please) attach both frontends: `agent-ide-bridge.vsix` and the
standalone `claude-diff` bundle.

## Status

Diff bridge only — no chat/webview. Implements the Claude Code IDE protocol (MCP over
WebSocket), with two frontends: VS Code / code-server and a terminal CLI (usable
standalone or as a herdr plugin).
