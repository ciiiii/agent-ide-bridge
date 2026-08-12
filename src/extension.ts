import * as vscode from "vscode";
import { EditorBridge } from "./core/editorBridge";
import { ClaudeAdapter } from "./adapters/claude/server";

let bridge: EditorBridge | undefined;
let adapter: ClaudeAdapter | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Claude IDE Bridge", { log: true });
  context.subscriptions.push(log);

  bridge = new EditorBridge();
  context.subscriptions.push(bridge);

  adapter = new ClaudeAdapter(bridge, context, log);
  context.subscriptions.push(adapter);

  // Accept / reject the focused proposed diff. Use the official command IDs
  // (+ legacy aliases) so any existing keybindings keep working.
  const accept = () => bridge?.acceptActiveDiff();
  const reject = () => bridge?.rejectActiveDiff();
  context.subscriptions.push(
    vscode.commands.registerCommand("claude-code.acceptProposedDiff", accept),
    vscode.commands.registerCommand("claude-code.rejectProposedDiff", reject),
    vscode.commands.registerCommand("claude-vscode.acceptProposedDiff", accept),
    vscode.commands.registerCommand("claude-vscode.rejectProposedDiff", reject),
    vscode.commands.registerCommand("claudeIdeBridge.showStatus", () => {
      vscode.window.showInformationMessage(adapter?.status() ?? "not started");
    })
  );

  try {
    await adapter.start();
    log.info("Claude IDE Bridge active");
  } catch (err) {
    log.error(`failed to start: ${String(err)}`);
    vscode.window.showErrorMessage(`Claude IDE Bridge failed to start: ${String(err)}`);
  }
}

export function deactivate(): void {
  adapter?.dispose();
  bridge?.dispose();
}
