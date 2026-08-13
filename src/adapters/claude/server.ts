import type { IncomingMessage } from "node:http";
import * as vscode from "vscode";
import { RawData, WebSocket, WebSocketServer } from "ws";
import { EditorBridge } from "../../core/editorBridge";
import { SelectionInfo } from "../../core/types";
import { cleanupStaleLocks, writeLock, removeLock } from "./lockfile";
import {
  AUTH_HEADER,
  DEFAULT_PROTOCOL_VERSION,
  DIFF_RESULT,
  NOTIFY,
  SERVER_INFO,
  SSE_PORT_ENV,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL,
} from "./protocol";

/** Per-connection identity, captured from MCP `initialize` + `roots/list`. */
interface ClientMeta {
  name: string;
  version: string;
  since: Date;
  folder?: string; // the session's project root (from roots/list)
}

/**
 * Claude Code IDE protocol adapter: a MULTI-CLIENT MCP-over-WebSocket server.
 *
 * Unlike the official extension (single client, evicts the previous connection)
 * this keeps every authenticated client and multiplexes them onto one shared
 * EditorBridge — so several `claude` sessions share one code-server window.
 */
export class ClaudeAdapter implements vscode.Disposable {
  private wss?: WebSocketServer;
  private port?: number;
  private authToken = "";
  private readonly clients = new Map<WebSocket, ClientMeta>();
  private readonly subs: vscode.Disposable[] = [];
  private statusBar?: vscode.StatusBarItem;
  private reqSeq = 0;
  private readonly pendingReqs = new Map<string | number, (result: unknown) => void>();

  constructor(
    private readonly bridge: EditorBridge,
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async start(): Promise<void> {
    cleanupStaleLocks(); // drop locks left by dead servers so discovery is clean
    this.wss = await this.createServer();
    this.port = (this.wss.address() as { port: number }).port;

    const { authToken } = writeLock(
      this.port,
      this.bridge.getWorkspaceFolders(),
      vscode.env.appName
    );
    this.authToken = authToken;

    // Make code-server's own integrated terminals auto-connect, like the official
    // extension does. External terminals use the shell wrapper instead.
    this.ctx.environmentVariableCollection.replace(SSE_PORT_ENV, String(this.port));

    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    // Editor context: selection goes only to sessions whose project folder
    // contains the file; diagnostics are broadcast (the CLI filters by path).
    this.subs.push(
      this.bridge.onSelectionChanged((sel) => this.sendSelection(sel)),
      this.bridge.onDiagnosticsChanged((files) =>
        this.broadcast(NOTIFY.diagnosticsChanged, {
          uris: files.map((f) => vscode.Uri.file(f).toString()),
        })
      )
    );

    // Status bar item: live session count; click for the connection list.
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "agentIdeBridge.showStatus";
    this.updateStatus();
    this.statusBar.show();

    this.log.info(`listening on 127.0.0.1:${this.port} (lock written)`);
  }

  /**
   * Bind the configured fixed port when free (so the CLAUDE_CODE_SSE_PORT the CLI
   * holds stays valid across window reloads — no /ide dance), else a random one.
   */
  private async createServer(): Promise<WebSocketServer> {
    const configured = vscode.workspace
      .getConfiguration("agentIdeBridge")
      .get<number>("port", 8991);
    for (const port of [configured, 0]) {
      try {
        const wss = new WebSocketServer({ host: "127.0.0.1", port });
        await new Promise<void>((resolve, reject) => {
          wss.once("listening", resolve);
          wss.once("error", reject);
        });
        return wss;
      } catch (e) {
        this.log.warn(`port ${port} bind failed (${String(e)})`);
      }
    }
    throw new Error("failed to bind a port");
  }

  private updateStatus(): void {
    if (!this.statusBar) return;
    const n = this.clients.size;
    // Keep the hover cheap and static (a rebuilt MarkdownString flickered); the
    // full list is shown on click.
    this.statusBar.text = `$(plug) Agent Bridge: ${n}`;
    this.statusBar.tooltip = `Agent IDE Bridge · ${n} session(s) · click for details`;
    this.statusBar.backgroundColor =
      n === 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  /** Show the live connection list as a popup list — bound to the status bar click. */
  showConnections(): void {
    const qp = vscode.window.createQuickPick();
    qp.title = `Agent IDE Bridge — 127.0.0.1:${this.port ?? "?"}`;
    qp.placeholder = `${this.clients.size} session(s) connected`;
    qp.items =
      this.clients.size === 0
        ? [{ label: "$(circle-slash) No sessions connected" }]
        : [...this.clients.values()].map((m) => ({
            label: `$(folder) ${m.folder ? basename(m.folder) : m.name || "(handshaking)"}`,
            description: m.version ? `${m.name} v${m.version}` : m.name,
            detail: `${m.folder ?? "(folder unknown)"} · since ${m.since.toLocaleTimeString()}`,
          }));
    qp.onDidAccept(() => qp.hide());
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  status(): string {
    return this.port
      ? `Agent IDE Bridge: 127.0.0.1:${this.port}, ${this.clients.size} client(s)`
      : "Agent IDE Bridge: not started";
  }

  // ---- connections ----------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const token = req.headers[AUTH_HEADER];
    if (token !== this.authToken) {
      this.log.warn("rejected unauthorized WS connection");
      ws.close(1008, "Unauthorized");
      return;
    }
    // multi-client: never evict a previous connection
    this.clients.set(ws, { name: "(handshaking)", version: "", since: new Date() });
    this.log.info(`client connected (${this.clients.size} total)`);
    this.updateStatus();

    ws.on("message", (data) => void this.onMessage(ws, data));
    ws.on("close", () => {
      this.clients.delete(ws);
      this.log.info(`client disconnected (${this.clients.size} left)`);
      this.updateStatus();
    });
    ws.on("error", (e) => this.log.warn(`ws error: ${String(e)}`));
  }

  private async onMessage(ws: WebSocket, data: RawData): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    this.log.trace(`recv ${data.toString()}`);

    // Response to a request WE sent (has id + result/error, no method).
    if (msg.id != null && msg.method === undefined) {
      const resolve = this.pendingReqs.get(msg.id);
      if (resolve) {
        this.pendingReqs.delete(msg.id);
        resolve(msg.result);
      }
      return;
    }

    // Requests carry an id; notifications (initialized, cancelled) do not.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      if (msg.method === "initialize") this.rememberClient(ws, msg.params);
      try {
        const result = await this.handleRequest(msg.method, msg.params ?? {});
        this.send(ws, { jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        this.send(ws, {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: errMsg(err) },
        });
      }
    } else if (msg.method === "notifications/initialized") {
      // The CLI is ready: learn its project root first, then push the current
      // selection (filtered to that folder) so the active file shows under it.
      void this.requestRoots(ws);
    }
  }

  /** Record the client's identity from initialize's clientInfo for the status list. */
  private rememberClient(ws: WebSocket, params?: JsonObject): void {
    const meta = this.clients.get(ws);
    if (!meta) return;
    const info = (params?.clientInfo ?? {}) as { name?: string; version?: string };
    meta.name = str(info.name) || meta.name;
    meta.version = str(info.version);
    this.updateStatus();
  }

  /** Ask the client for its workspace roots (its project folder) via MCP roots/list. */
  private async requestRoots(ws: WebSocket): Promise<void> {
    const id = `roots-${++this.reqSeq}`;
    const result = await new Promise<unknown>((resolve) => {
      this.pendingReqs.set(id, resolve);
      this.send(ws, { jsonrpc: "2.0", id, method: "roots/list", params: {} });
      setTimeout(() => {
        if (this.pendingReqs.delete(id)) resolve(undefined);
      }, 3000);
    });
    const roots = (result as { roots?: Array<{ uri?: string }> } | undefined)?.roots ?? [];
    const meta = this.clients.get(ws);
    if (meta && roots[0]?.uri) {
      meta.folder = uriToPath(roots[0].uri);
      this.updateStatus();
    }
    this.pushSelection(ws); // now that the folder is known, show the active file if in-folder
  }

  /** A selection reaches a session only if the file is within its project folder. */
  private selectionAllowed(filePath: string | null, meta: ClientMeta): boolean {
    if (!meta.folder || !filePath) return true; // unknown folder / non-file editor: don't hide
    return filePath === meta.folder || filePath.startsWith(meta.folder + "/");
  }

  /** Push the current selection to one client, if it's inside that session's folder. */
  private pushSelection(ws: WebSocket): void {
    const sel = this.bridge.getCurrentSelection();
    const meta = this.clients.get(ws);
    if (sel && meta && this.selectionAllowed(sel.filePath, meta)) {
      this.notify(ws, NOTIFY.selectionChanged, selectionParams(sel));
    }
  }

  /** Send a selection to every session whose project folder contains the file. */
  private sendSelection(sel: SelectionInfo): void {
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      method: NOTIFY.selectionChanged,
      params: selectionParams(sel),
    });
    for (const [ws, meta] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && this.selectionAllowed(sel.filePath, meta)) {
        ws.send(frame);
      }
    }
  }

  private notify(ws: WebSocket, method: string, params: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    }
  }

  private async handleRequest(method: string, params: JsonObject): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = str(params.protocolVersion);
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: SERVER_INFO,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolDefs() };
      case "tools/call":
        return await this.callTool(String(params.name), (params.arguments as JsonObject) ?? {});
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  // ---- tool dispatch --------------------------------------------------------

  private async callTool(name: string, args: JsonObject): Promise<ToolResult> {
    switch (name) {
      case TOOL.openDiff: {
        const filePath = str(args.old_file_path ?? args.new_file_path ?? args.filePath ?? args.path);
        const newContent = str(args.new_file_contents ?? args.content ?? args.newContent ?? "");
        const tabName = str(args.tab_name ?? args.tabName ?? `✻ [Claude Code] ${basename(filePath)}`);
        const outcome = await this.bridge.openDiff({ filePath, newContent, tabName });
        return outcome.status === "saved"
          ? textPair(DIFF_RESULT.saved, outcome.content)
          : textPair(DIFF_RESULT.rejected, tabName);
      }
      case TOOL.closeTab:
        await this.bridge.closeTab(str(args.tab_name ?? args.tabName));
        return text(DIFF_RESULT.tabClosed);
      case TOOL.closeAllDiffTabs: {
        const n = await this.bridge.closeAllDiffTabs();
        return text(`CLOSED_${n}_DIFF_TABS`);
      }
      case TOOL.getCurrentSelection:
      case TOOL.getLatestSelection: {
        const sel = this.bridge.getCurrentSelection();
        return json(
          sel
            ? {
                success: true,
                text: sel.text,
                filePath: sel.filePath,
                fileUrl: sel.filePath ? vscode.Uri.file(sel.filePath).toString() : null,
                selection: { start: sel.start, end: sel.end, isEmpty: sel.isEmpty },
              }
            : { success: false, message: "No active editor found" }
        );
      }
      case TOOL.getOpenEditors:
        return json({
          tabs: this.bridge.getOpenEditors().map((e) => ({
            uri: vscode.Uri.file(e.filePath).toString(),
            filePath: e.filePath,
            isActive: e.isActive,
            isDirty: e.isDirty,
          })),
        });
      case TOOL.getWorkspaceFolders: {
        const folders = this.bridge.getWorkspaceFolders();
        return json({
          success: true,
          folders: folders.map((p, index) => ({
            name: basename(p),
            uri: vscode.Uri.file(p).toString(),
            path: p,
            index,
          })),
          rootPath: folders[0] ?? null,
          workspaceFile: null,
        });
      }
      case TOOL.getDiagnostics:
        return json(
          this.bridge.getDiagnostics(args.uri ? uriToPath(str(args.uri)) : undefined).map((f) => ({
            uri: vscode.Uri.file(f.filePath).toString(),
            diagnostics: f.diagnostics.map((d) => ({
              message: d.message,
              severity: capitalize(d.severity),
              range: d.range,
              source: d.source,
              code: d.code,
            })),
          }))
        );
      case TOOL.openFile: {
        const filePath = str(args.filePath ?? args.path);
        await this.bridge.openFile(filePath);
        return text(`Opened file ${filePath}`);
      }
      case TOOL.saveDocument: {
        const filePath = str(args.filePath ?? args.path);
        const st = this.bridge.documentState(filePath);
        if (!st.open) return json({ success: false, message: `Document not open: ${filePath}` });
        const saved = await this.bridge.saveDocument(filePath);
        return json({
          success: true,
          filePath,
          saved,
          message: saved ? "Document saved successfully" : "Document was not dirty or save failed",
        });
      }
      case TOOL.checkDocumentDirty: {
        const filePath = str(args.filePath ?? args.path);
        const st = this.bridge.documentState(filePath);
        return json(
          st.open
            ? { success: true, filePath, isDirty: st.dirty, isUntitled: st.untitled }
            : { success: false, message: `Document not open: ${filePath}` }
        );
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  // ---- transport helpers ----------------------------------------------------

  private broadcast(method: string, params: unknown): void {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }

  private send(ws: WebSocket, msg: object): void {
    const frame = JSON.stringify(msg);
    this.log.trace(`send ${frame}`);
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }

  dispose(): void {
    for (const d of this.subs) d.dispose();
    for (const ws of this.clients.keys()) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.statusBar?.dispose();
    this.wss?.close();
    if (this.port !== undefined) removeLock(this.port);
    this.ctx.environmentVariableCollection.delete(SSE_PORT_ENV);
  }
}

// ---- tool definitions -------------------------------------------------------

function toolDefs(): Array<{ name: string; description: string; inputSchema: object }> {
  const s = (properties: object, required: string[] = []) => ({
    type: "object",
    properties,
    required,
  });
  return [
    {
      name: TOOL.openDiff,
      description: "Open a git diff for the file",
      inputSchema: s(
        {
          old_file_path: { type: "string" },
          new_file_path: { type: "string" },
          new_file_contents: { type: "string" },
          tab_name: { type: "string" },
        },
        ["old_file_path", "new_file_path", "new_file_contents", "tab_name"]
      ),
    },
    { name: TOOL.closeTab, description: "Close a tab by name.", inputSchema: s({ tab_name: { type: "string" } }, ["tab_name"]) },
    { name: TOOL.closeAllDiffTabs, description: "Close all open diff tabs.", inputSchema: s({}) },
    { name: TOOL.getDiagnostics, description: "Get language diagnostics.", inputSchema: s({ uri: { type: "string" } }) },
    { name: TOOL.getCurrentSelection, description: "Get the current editor selection.", inputSchema: s({}) },
    { name: TOOL.getLatestSelection, description: "Get the most recent editor selection.", inputSchema: s({}) },
    { name: TOOL.getOpenEditors, description: "List open editors.", inputSchema: s({}) },
    { name: TOOL.getWorkspaceFolders, description: "List workspace folders.", inputSchema: s({}) },
    { name: TOOL.openFile, description: "Open a file in the editor.", inputSchema: s({ filePath: { type: "string" } }, ["filePath"]) },
    { name: TOOL.saveDocument, description: "Save an open document.", inputSchema: s({ filePath: { type: "string" } }, ["filePath"]) },
    { name: TOOL.checkDocumentDirty, description: "Check whether a document has unsaved changes.", inputSchema: s({ filePath: { type: "string" } }, ["filePath"]) },
  ];
}

// ---- small helpers ----------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: unknown;
}
type JsonObject = Record<string, unknown>;
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}
/** Two-element text content, as openDiff returns [marker, payload]. */
function textPair(a: string, b: string): ToolResult {
  return { content: [{ type: "text", text: a }, { type: "text", text: b }] };
}
function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Accept either a file:// URI or a plain path; return an fs path. */
function uriToPath(s: string): string {
  return s.startsWith("file:") ? vscode.Uri.parse(s).fsPath : s;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function selectionParams(sel: SelectionInfo): object {
  return {
    text: sel.text,
    filePath: sel.filePath,
    fileUrl: sel.filePath ? vscode.Uri.file(sel.filePath).toString() : null,
    selection: {
      start: sel.start,
      end: sel.end,
      isEmpty: sel.isEmpty,
    },
  };
}
