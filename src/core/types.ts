// Tool-agnostic types shared between the editor core and protocol adapters.
// Nothing here knows about Claude, MCP, or any specific CLI wire format.
// (diff test — safe to revert)

export interface DiffRequest {
  /** Absolute path of the real on-disk file (left side of the diff). */
  filePath: string;
  /** Proposed new content (right side of the diff). */
  newContent: string;
  /** Display title for the diff tab. */
  tabName: string;
}

/** Outcome of a diff the user reviewed. */
export type DiffOutcome =
  | { status: "saved"; content: string } // accepted; `content` is what was saved
  | { status: "rejected" } // explicitly rejected or closed without saving
  | { status: "no_diff" }; // no diff was open / already resolved

export interface Position {
  line: number;
  character: number;
}

export interface SelectionInfo {
  /** Selected text ("" when the selection is empty). */
  text: string;
  /** Absolute path of the active file, or null when none. */
  filePath: string | null;
  start: Position;
  end: Position;
  isEmpty: boolean;
}

export interface OpenEditorInfo {
  filePath: string;
  isActive: boolean;
  isDirty: boolean;
}

export interface DiagnosticItem {
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  range: { start: Position; end: Position };
  source?: string;
  code?: string | number;
}

export interface FileDiagnostics {
  filePath: string;
  diagnostics: DiagnosticItem[];
}

/** Minimal disposable, structurally compatible with vscode.Disposable. */
export interface Disposable {
  dispose(): void;
}

/** Minimal logger, structurally compatible with vscode.LogOutputChannel. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  trace(message: string): void;
}

/** Neutral view of one connected agent session (for status displays). */
export interface ConnectionInfo {
  name: string;
  version: string;
  folder?: string;
  since: Date;
}

/**
 * The editor surface a protocol adapter drives. VS Code (EditorBridge) and the
 * terminal CLI (TerminalDiffFrontend) each implement this; the Claude adapter
 * depends only on this interface, never on a concrete frontend.
 */
export interface EditorFrontend {
  openDiff(request: DiffRequest): Promise<DiffOutcome>;
  closeTab(tabName: string): Promise<void>;
  closeAllDiffTabs(): Promise<number>;
  acceptActiveDiff(): Promise<boolean>;
  rejectActiveDiff(): Promise<boolean>;
  getCurrentSelection(): SelectionInfo | null;
  getOpenEditors(): OpenEditorInfo[];
  getWorkspaceFolders(): string[];
  getDiagnostics(filePath?: string): FileDiagnostics[];
  openFile(filePath: string): Promise<void>;
  saveDocument(filePath: string): Promise<boolean>;
  documentState(filePath: string): { open: boolean; dirty: boolean; untitled: boolean };
  onSelectionChanged(listener: (sel: SelectionInfo) => void): Disposable;
  onDiagnosticsChanged(listener: (files: string[]) => void): Disposable;
}
