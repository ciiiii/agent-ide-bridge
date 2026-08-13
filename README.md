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

```
src/
  core/            # tool-agnostic: diff engine, editor queries, change events
    editorBridge.ts
    types.ts
  adapters/
    claude/        # Claude IDE protocol: lockfile + MCP-over-WS server
      server.ts
      lockfile.ts
      protocol.ts
  extension.ts     # wires core + adapter + accept/reject commands
```

`core/` knows nothing about Claude; a future `adapters/<tool>/` can reuse it.

## Build

```bash
npm install
npm run build          # -> dist/extension.js (esbuild bundle)
npm run package        # -> agent-ide-bridge.vsix
```

## Install (code-server)

```bash
code-server --install-extension agent-ide-bridge.vsix
code-server --uninstall-extension anthropic.claude-code   # avoid lockfile conflicts
# reload the window (or restart the code-server service)
```

Accept / reject the focused diff: `Cmd+Enter` / `Cmd+Backspace` (bound to
`claude-code.acceptProposedDiff` / `…rejectProposedDiff`).

## Status

Diff bridge only — no chat/webview. Implements the Claude Code IDE protocol
(MCP over WebSocket).
