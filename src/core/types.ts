// Tool-agnostic types shared between the editor core and protocol adapters.
// Nothing here knows about Claude, MCP, or any specific CLI wire format.

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
