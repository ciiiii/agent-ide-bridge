// Claude Code IDE protocol constants (reverse-engineered from the official
// extension). Verified against the live ~/.claude/ide/*.lock files and the
// extension's connection handler; exact tool schemas are confirmed by the
// protocol spec doc and by capturing a real `claude` handshake.

/** WebSocket upgrade header carrying the lockfile authToken. */
export const AUTH_HEADER = "x-claude-code-ide-authorization";

/** Advertised IDE name in the lockfile / picker. */
export const IDE_NAME = "code-server";

// MCP: echo the client's requested protocolVersion when supported, else default.
export const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

export const SERVER_INFO = {
  name: "Agent IDE Bridge MCP",
  version: "0.0.1",
};

/** IDE tools exposed via tools/list and invoked via tools/call. */
export const TOOL = {
  openDiff: "openDiff",
  closeTab: "close_tab",
  closeAllDiffTabs: "closeAllDiffTabs",
  getDiagnostics: "getDiagnostics",
  getCurrentSelection: "getCurrentSelection",
  getLatestSelection: "getLatestSelection",
  getOpenEditors: "getOpenEditors",
  getWorkspaceFolders: "getWorkspaceFolders",
  openFile: "openFile",
  saveDocument: "saveDocument",
  checkDocumentDirty: "checkDocumentDirty",
} as const;

/** openDiff result markers returned to the CLI. */
export const DIFF_RESULT = {
  saved: "FILE_SAVED",
  rejected: "DIFF_REJECTED",
  tabClosed: "TAB_CLOSED",
} as const;

/** JSON-RPC notification methods pushed IDE → CLI. */
export const NOTIFY = {
  selectionChanged: "selection_changed",
  atMentioned: "at_mentioned",
  diagnosticsChanged: "diagnostics_changed",
} as const;

/** Terminal env var the CLI reads to auto-connect to this window's server. */
export const SSE_PORT_ENV = "CLAUDE_CODE_SSE_PORT";
