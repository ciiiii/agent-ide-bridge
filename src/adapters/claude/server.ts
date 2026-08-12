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

/**
 * Claude Code IDE protocol adapter: a MULTI-CLIENT MCP-over-WebSocket server.
 *
 * Unlike the official extension (single client, evicts the previous connection)
 * this keeps every authenticated client and multiplexes them onto one shared
 * EditorBridge — so several `claude` sessions share one code-server window.
 *
 * NOTE: `initialize` response and tool argument names are cross-checked against
 * the protocol spec + a captured real handshake. All incoming frames are logged
 * at trace level so the exact wire shapes can be confirmed empirically.
 */
export class ClaudeAdapter implements vscode.Disposable {
  private wss?: WebSocketServer;
  private port?: number;
  private authToken = "";
  private readonly clients = new Set<WebSocket>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly bridge: EditorBridge,
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async start(): Promise<void> {
    cleanupStaleLocks(); // drop locks left by dead servers so discovery is clean
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    this.port = (wss.address() as { port: number }).port;

    const { authToken } = writeLock(
      this.port,
      this.bridge.getWorkspaceFolders(),
      vscode.env.appName
    );
    this.authToken = authToken;

    // Make code-server's own integrated terminals auto-connect, like the official
    // extension does. External terminals use the shell wrapper instead.
    this.ctx.environmentVariableCollection.replace(SSE_PORT_ENV, String(this.port));

    wss.on("connection", (ws, req) => this.onConnection(ws, req));

    // Broadcast editor context to every connected session.
    this.subs.push(
      this.bridge.onSelectionChanged((sel) =>
        this.broadcast(NOTIFY.selectionChanged, selectionParams(sel))
      ),
      this.bridge.onDiagnosticsChanged((files) =>
        this.broadcast(NOTIFY.diagnosticsChanged, {
          uris: files.map((f) => vscode.Uri.file(f).toString()),
        })
      )
    );

    this.log.info(`listening on 127.0.0.1:${this.port} (lock written)`);
  }

  status(): string {
    return this.port
      ? `Claude IDE Bridge: 127.0.0.1:${this.port}, ${this.clients.size} client(s)`
      : "Claude IDE Bridge: not started";
  }

  // ---- connections ----------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const token = req.headers[AUTH_HEADER];
    if (token !== this.authToken) {
      this.log.warn("rejected unauthorized WS connection");
      ws.close(1008, "Unauthorized");
      return;
    }
    this.clients.add(ws); // multi-client: never evict a previous connection
    this.log.info(`client connected (${this.clients.size} total)`);

    ws.on("message", (data) => void this.onMessage(ws, data));
    ws.on("close", () => {
      this.clients.delete(ws);
      this.log.info(`client disconnected (${this.clients.size} left)`);
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

    // Requests carry an id; notifications (initialized, cancelled) do not.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
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
    for (const ws of this.clients) {
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
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
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
  return p.split("/").pop() || p;
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
