import * as vscode from "vscode";
import { EditorBridge } from "./core/editorBridge";
import { ClaudeAdapter } from "./adapters/claude/server";
import { SSE_PORT_ENV } from "./adapters/claude/protocol";

let bridge: EditorBridge | undefined;
let adapter: ClaudeAdapter | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Agent IDE Bridge", { log: true });
  context.subscriptions.push(log);

  bridge = new EditorBridge();
  context.subscriptions.push(bridge);

  const port = vscode.workspace.getConfiguration("agentIdeBridge").get<number>("port", 8991);
  adapter = new ClaudeAdapter(bridge, { port, ideName: vscode.env.appName, log });
  context.subscriptions.push(adapter);

  // Status bar item: live session count; click for the connection list.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "agentIdeBridge.showStatus";
  const updateStatus = () => {
    const n = adapter?.clientCount ?? 0;
    // Keep the hover cheap and static (a rebuilt MarkdownString flickered); the
    // full list is shown on click.
    statusBar.text = `$(plug) Agent Bridge: ${n}`;
    statusBar.tooltip = `Agent IDE Bridge · ${n} session(s) · click for details`;
    statusBar.backgroundColor =
      n === 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  };
  updateStatus();
  statusBar.show();
  context.subscriptions.push(statusBar, adapter.onClientsChanged(updateStatus));

  // Accept / reject the focused proposed diff. Use the official command IDs
  // (+ legacy aliases) so any existing keybindings keep working.
  const accept = () => bridge?.acceptActiveDiff();
  const reject = () => bridge?.rejectActiveDiff();
  context.subscriptions.push(
    vscode.commands.registerCommand("claude-code.acceptProposedDiff", accept),
    vscode.commands.registerCommand("claude-code.rejectProposedDiff", reject),
    vscode.commands.registerCommand("claude-vscode.acceptProposedDiff", accept),
    vscode.commands.registerCommand("claude-vscode.rejectProposedDiff", reject),
    vscode.commands.registerCommand("agentIdeBridge.showStatus", () => showConnections(adapter))
  );

  try {
    await adapter.start();
    // Make code-server's own integrated terminals auto-connect, like the official
    // extension does. External terminals use the shell wrapper / CLI instead.
    if (adapter.port !== undefined) {
      context.environmentVariableCollection.replace(SSE_PORT_ENV, String(adapter.port));
    }
    log.info("Agent IDE Bridge active");
  } catch (err) {
    log.error(`failed to start: ${String(err)}`);
    vscode.window.showErrorMessage(`Agent IDE Bridge failed to start: ${String(err)}`);
  }
}

/** Show the live connection list as a popup — bound to the status bar click. */
function showConnections(adapter: ClaudeAdapter | undefined): void {
  const conns = adapter?.getConnections() ?? [];
  const qp = vscode.window.createQuickPick();
  qp.title = `Agent IDE Bridge — 127.0.0.1:${adapter?.port ?? "?"}`;
  qp.placeholder = `${conns.length} session(s) connected`;
  qp.items =
    conns.length === 0
      ? [{ label: "$(circle-slash) No sessions connected" }]
      : conns.map((m) => ({
          label: `$(folder) ${m.folder ? basename(m.folder) : m.name || "(handshaking)"}`,
          description: m.version ? `${m.name} v${m.version}` : m.name,
          detail: `${m.folder ?? "(folder unknown)"} · since ${m.since.toLocaleTimeString()}`,
        }));
  qp.onDidAccept(() => qp.hide());
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export function deactivate(): void {
  adapter?.dispose();
  bridge?.dispose();
}
