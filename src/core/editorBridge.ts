import * as vscode from "vscode";
import {
  DiagnosticItem,
  DiffOutcome,
  DiffRequest,
  FileDiagnostics,
  OpenEditorInfo,
  SelectionInfo,
} from "./types";

/** Virtual scheme that backs the right-hand ("proposed") side of a diff. */
const PROPOSED_SCHEME = "agent-bridge-proposed";

interface PendingDiff {
  id: string;
  request: DiffRequest;
  rightUri: vscode.Uri;
  resolve: (outcome: DiffOutcome) => void;
  resolved: boolean;
}

/**
 * Tool-agnostic wrapper over the VS Code window/editor API.
 *
 * Owns the diff lifecycle (open → user accepts/rejects → resolve) and exposes
 * plain editor queries + change events. Protocol adapters translate their wire
 * format to/from these primitives; nothing here is Claude- or MCP-specific.
 *
 * Multiple diffs can be open at once (one per session); each is keyed by a
 * unique right-hand URI so accept/reject resolves exactly the intended one.
 */
export class EditorBridge implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<string, PendingDiff>(); // key: rightUri.toString()
  private readonly proposedContent = new Map<string, string>(); // key: diff id
  private seq = 0;

  private readonly _onSelectionChanged = new vscode.EventEmitter<SelectionInfo>();
  readonly onSelectionChanged = this._onSelectionChanged.event;

  private readonly _onDiagnosticsChanged = new vscode.EventEmitter<string[]>();
  /** Fires with the list of file paths whose diagnostics changed. */
  readonly onDiagnosticsChanged = this._onDiagnosticsChanged.event;

  constructor() {
    // Serve proposed content for the right-hand side of diffs.
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
        provideTextDocumentContent: (uri) =>
          this.proposedContent.get(uri.query) ?? "",
      })
    );

    // Close leftover proposed-diff tabs from a previous window session — their
    // in-memory content is gone after a reload, so restoring them errors with
    // "The editor could not be opened because the file was not found."
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (diffRightUri(tab)) void vscode.window.tabGroups.close(tab, false);
      }
    }

    // Selection / active-editor changes → neutral SelectionInfo.
    const emitSelection = () => {
      const info = this.getCurrentSelection();
      if (info) this._onSelectionChanged.fire(info);
    };
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(emitSelection),
      vscode.window.onDidChangeActiveTextEditor(emitSelection)
    );

    // Diagnostics changes → affected file paths.
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        const files = e.uris
          .filter((u) => u.scheme === "file")
          .map((u) => u.fsPath);
        if (files.length) this._onDiagnosticsChanged.fire(files);
      })
    );

    // A closed diff tab that was never accepted counts as a rejection.
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
          const uri = diffRightUri(tab);
          if (!uri) continue;
          const p = this.pending.get(uri.toString());
          if (p && !p.resolved) this.settle(p, { status: "rejected" });
        }
        this.updateDiffContext();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateDiffContext())
    );
  }

  /** Expose whether one of our proposed diffs is focused (for accept/reject keybindings). */
  private updateDiffContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "agentIdeBridge.diffActive",
      this.activePending() !== undefined
    );
  }

  // ---- Diff lifecycle -------------------------------------------------------

  /** Open a diff and resolve when the user accepts or rejects it. */
  async openDiff(request: DiffRequest): Promise<DiffOutcome> {
    const id = `${++this.seq}:${request.filePath}`;
    const leftUri = vscode.Uri.file(request.filePath);
    const rightUri = vscode.Uri.from({
      scheme: PROPOSED_SCHEME,
      path: request.filePath, // keeps the filename visible in the diff title
      query: id,
    });
    this.proposedContent.set(id, request.newContent);

    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      request.tabName,
      { preview: false }
    );

    return new Promise<DiffOutcome>((resolve) => {
      this.pending.set(rightUri.toString(), {
        id,
        request,
        rightUri,
        resolve,
        resolved: false,
      });
    });
  }

  /** Accept the currently focused proposed diff (writes the file). */
  async acceptActiveDiff(): Promise<boolean> {
    const p = this.activePending();
    if (!p) return false;
    await this.acceptPending(p);
    return true;
  }

  /** Reject the currently focused proposed diff. */
  async rejectActiveDiff(): Promise<boolean> {
    const p = this.activePending();
    if (!p) return false;
    await this.rejectPending(p);
    return true;
  }

  /**
   * Close a specific diff tab by name. Matches the official `close_tab` on a
   * Claude diff: it saves the proposed content first, i.e. accepts.
   */
  async closeTab(tabName: string): Promise<void> {
    for (const p of [...this.pending.values()]) {
      if (p.request.tabName === tabName) await this.acceptPending(p);
    }
  }

  /** Close every open proposed diff, saving (accepting) each — as the official does. */
  async closeAllDiffTabs(): Promise<number> {
    const open = [...this.pending.values()];
    for (const p of open) await this.acceptPending(p);
    return open.length;
  }

  private async acceptPending(p: PendingDiff): Promise<void> {
    // Do NOT write the file here. openDiff only PREVIEWS the change; the CLI
    // applies the edit itself after we return FILE_SAVED. Writing here changes
    // the file mid-edit and trips the CLI's "File content has changed since it
    // was last read" guard.
    // Settle BEFORE closing the tab so the close listener doesn't race us to
    // "rejected" (settle removes p from `pending`, making that handler a no-op).
    this.settle(p, { status: "saved", content: p.request.newContent });
    await closeDiffTab(p.rightUri);
  }

  private async rejectPending(p: PendingDiff): Promise<void> {
    this.settle(p, { status: "rejected" });
    await closeDiffTab(p.rightUri);
  }

  private activePending(): PendingDiff | undefined {
    const uri = diffRightUri(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (uri) {
      const p = this.pending.get(uri.toString());
      if (p && !p.resolved) return p;
    }
    // Fall back to the single open diff, if unambiguous.
    const live = [...this.pending.values()].filter((p) => !p.resolved);
    return live.length === 1 ? live[0] : undefined;
  }

  private settle(p: PendingDiff, outcome: DiffOutcome): void {
    if (p.resolved) return;
    p.resolved = true;
    this.pending.delete(p.rightUri.toString());
    this.proposedContent.delete(p.id);
    p.resolve(outcome);
  }

  // ---- Editor queries -------------------------------------------------------

  getCurrentSelection(): SelectionInfo | null {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return null;
    const sel = ed.selection;
    return {
      text: ed.document.getText(sel),
      filePath: ed.document.uri.scheme === "file" ? ed.document.uri.fsPath : null,
      start: { line: sel.start.line, character: sel.start.character },
      end: { line: sel.end.line, character: sel.end.character },
      isEmpty: sel.isEmpty,
    };
  }

  getOpenEditors(): OpenEditorInfo[] {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const out: OpenEditorInfo[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.scheme === "file") {
          out.push({
            filePath: input.uri.fsPath,
            isActive: input.uri.toString() === active,
            isDirty: tab.isDirty,
          });
        }
      }
    }
    return out;
  }

  getWorkspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  getDiagnostics(filePath?: string): FileDiagnostics[] {
    const entries = filePath
      ? ([[vscode.Uri.file(filePath), vscode.languages.getDiagnostics(vscode.Uri.file(filePath))]] as [
          vscode.Uri,
          vscode.Diagnostic[]
        ][])
      : vscode.languages.getDiagnostics();
    const out: FileDiagnostics[] = [];
    for (const [uri, diags] of entries) {
      if (uri.scheme !== "file" || diags.length === 0) continue;
      out.push({ filePath: uri.fsPath, diagnostics: diags.map(toDiagnosticItem) });
    }
    return out;
  }

  async openFile(filePath: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async saveDocument(filePath: string): Promise<boolean> {
    const target = vscode.Uri.file(filePath).toString();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.toString() === target) return doc.save();
    }
    return false;
  }

  documentState(filePath: string): { open: boolean; dirty: boolean; untitled: boolean } {
    const target = vscode.Uri.file(filePath).toString();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target);
    return { open: !!doc, dirty: !!doc?.isDirty, untitled: !!doc?.isUntitled };
  }

  dispose(): void {
    for (const p of this.pending.values()) this.settle(p, { status: "rejected" });
    this._onSelectionChanged.dispose();
    this._onDiagnosticsChanged.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// ---- helpers ----------------------------------------------------------------

/** If a tab is a diff whose right side is our proposed scheme, return that URI. */
function diffRightUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  const input = tab?.input;
  if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROPOSED_SCHEME) {
    return input.modified;
  }
  return undefined;
}

async function closeDiffTab(rightUri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (diffRightUri(tab)?.toString() === rightUri.toString()) {
        await vscode.window.tabGroups.close(tab, false);
        return;
      }
    }
  }
}

function toDiagnosticItem(d: vscode.Diagnostic): DiagnosticItem {
  const sev: DiagnosticItem["severity"] =
    d.severity === vscode.DiagnosticSeverity.Error
      ? "error"
      : d.severity === vscode.DiagnosticSeverity.Warning
      ? "warning"
      : d.severity === vscode.DiagnosticSeverity.Information
      ? "information"
      : "hint";
  return {
    message: d.message,
    severity: sev,
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    source: d.source,
    code:
      typeof d.code === "object" && d.code !== null
        ? (d.code.value as string | number)
        : (d.code as string | number | undefined),
  };
}
