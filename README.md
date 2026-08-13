# Agent IDE Bridge

A **multi-client** IDE diff bridge for code-server. It lets several Claude Code
sessions share **one** code-server window — each with working in-editor diffs
(accept/reject), selection context, and diagnostics.

## Why

By default only one Claude Code session can attach to a code-server window at a
time, so two sessions in one window fight over the slot and only the newest gets
diffs. This extension speaks the Claude IDE protocol (MCP over WebSocket,
discovered via `~/.claude/ide/<port>.lock`) but keeps **all** connected clients
and multiplexes them onto the one window.

## Architecture

The Claude adapter (the MCP-over-WS server) is frontend-agnostic: it drives an
`EditorFrontend`, of which there are two — VS Code and the terminal. Same
protocol, two surfaces.

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
  cli/               # EditorFrontend #2 — terminal diff pager (the CLI)
    index.ts
    terminalFrontend.ts
  extension.ts       # wires the VS Code frontend + adapter + accept/reject commands

herdr-plugin.toml    # herdr plugin: run the CLI in a pane beside the agent
herdr/pane.sh
```

`core/` and `adapters/claude/` know nothing about VS Code; the CLI reuses them
verbatim.

## Build

```bash
npm install
npm run build          # -> dist/extension.js + dist/cli.js (esbuild bundles)
npm run package        # -> agent-ide-bridge.vsix
npm test               # e2e: drive the CLI over the Claude protocol (non-TTY path)
npm run test:tui       # e2e: the interactive pager, driven through a real pty
```

## Install (code-server)

Grab the packaged `.vsix` from the latest release and install it:

```bash
curl -fsSL -o /tmp/aib.vsix \
  https://github.com/ciiiii/agent-ide-bridge/releases/latest/download/agent-ide-bridge.vsix \
  && code-server --install-extension /tmp/aib.vsix
```

Or build from source (`npm run package`) and install the local file:

```bash
code-server --install-extension agent-ide-bridge.vsix
code-server --uninstall-extension anthropic.claude-code   # avoid lockfile conflicts
# reload the window (or restart the code-server service)
```

Accept / reject the focused diff: `Cmd+Enter` / `Cmd+Backspace` (bound to
`claude-code.acceptProposedDiff` / `…rejectProposedDiff`).

## Terminal / herdr (no code-server)

The same bridge, without a browser: `dist/cli.js` (`claude-diff`) is a terminal
frontend that renders Claude's **proposed** diffs (accept/reject) right in a
terminal — rendered through [`delta`](https://github.com/dandavison/delta) when
present, with a scrollable pager (`j`/`k`, `space`/`b`, `g`/`G`, `y`/`n`).

Run it standalone in any terminal:

```bash
node dist/cli.js --dir ~/your/project        # prints its port + connect hint
# then, in another terminal:
cd ~/your/project
export CLAUDE_CODE_SSE_PORT=<port> && claude  # or run claude, then /ide
```

### As a herdr plugin

`herdr-plugin.toml` opens the CLI in a pane **beside the agent**, so Claude's
diffs show next to the session that proposed them:

```bash
herdr plugin link .        # local checkout (then: npm ci && npm run build)
# or: herdr plugin install <this repo/release>   (runs the build automatically)
```

Then, from inside herdr:

- Invoke **`claude-diff: toggle viewer`** (`herdr plugin action invoke cai.agent-ide-bridge.toggle`)
  to open the viewer pane to the right of the current agent.
- In the claude pane, run **`/ide`** to connect (or `export CLAUDE_CODE_SSE_PORT`
  before launching `claude`). Its proposed diffs now render in the viewer pane.

The viewer defaults to port `8990` (override with `AIB_DIFF_PORT`) and its split
side to `right` (`AIB_DIFF_DIRECTION`). Requires `jq`.

## Status

Diff bridge only — no chat/webview. Implements the Claude Code IDE protocol
(MCP over WebSocket), with two frontends: VS Code / code-server and a terminal
CLI (usable standalone or as a herdr plugin).
