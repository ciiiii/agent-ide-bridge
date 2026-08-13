# Claude IDE Bridge

A **multi-client** IDE diff bridge for code-server. It lets several Claude Code
sessions share **one** code-server window — each with working in-editor diffs
(accept/reject), selection context, and diagnostics.

## Why

The official Anthropic extension runs a **single-client** IDE server: every new
`claude` connection evicts the previous one (`Disconnecting previous WebSocket
client`). So two sessions in one window fight over the slot and only the newest
gets diffs. This extension speaks the same Claude IDE protocol (MCP over
WebSocket, discovered via `~/.claude/ide/<port>.lock`) but keeps **all**
connected clients and multiplexes them onto the one window.

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
npm run package        # -> claude-ide-bridge.vsix
```

## Install (code-server)

```bash
code-server --install-extension claude-ide-bridge.vsix
code-server --uninstall-extension anthropic.claude-code   # avoid lockfile conflicts
# reload the window (or restart the code-server service)
```

Accept / reject the focused diff: `Cmd+Enter` / `Cmd+Backspace` (bound to
`claude-code.acceptProposedDiff` / `…rejectProposedDiff`).

## Status

Diff bridge only — no chat/webview. Protocol reverse-engineered from the
official extension; see the in-repo notes for the message spec.

<!-- diff-bridge verification -->


<!-- diff-bridge verification -->


<!-- diff-bridge verification -->

