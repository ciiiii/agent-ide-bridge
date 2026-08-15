import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  Disposable,
  DiffOutcome,
  DiffRequest,
  EditorFrontend,
  FileDiagnostics,
  Logger,
  OpenEditorInfo,
  SelectionInfo,
} from "../core/types";

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

/**
 * accept/reject come from the viewer's own y/n (a definite decision). "handled" =
 * resolved on the claude side (close_tab / cancel), where claude gives no reliable
 * accept-vs-reject signal, so we don't guess. "closed" = the agent disconnected.
 */
type Verdict = "accept" | "reject" | "handled" | "closed";

/**
 * How a diff is rendered. "line" is delta's unified line diff (syntax highlighting,
 * one row per changed line). "word" is git's word-diff: the text is shown once with
 * only the changed words colored, which is far more readable when a change reflows a
 * block across a different number of lines. Toggled live with `w`.
 */
export type DiffView = "line" | "word";

interface ActiveDiff {
  acceptContent: string;
  settle: (verdict: Verdict) => void;
}

/**
 * Terminal implementation of the editor surface. Instead of a VS Code diff tab,
 * it renders each proposed diff (via `delta` when available) into a scrollable
 * pager and reads an accept/reject keystroke — so `claude` running in another
 * terminal / herdr pane shows its diffs here over the same protocol the VS Code
 * extension speaks.
 *
 * Only openDiff is interactive; the remaining editor queries are stubbed (a
 * terminal has no selection/diagnostics), which is all `claude` needs.
 */
export class TerminalDiffFrontend implements EditorFrontend {
  /** Serializes prompts so two sessions never fight over the one stdin. */
  private queue: Promise<unknown> = Promise.resolve();
  private active?: ActiveDiff;
  private seq = 0;

  private clearActive(): void {
    this.active = undefined;
  }

  constructor(private readonly opts: { cwd: string; log: Logger; view: DiffView }) {}

  async openDiff(request: DiffRequest): Promise<DiffOutcome> {
    const run = this.queue.then(() => this.prompt(request));
    this.queue = run.catch(() => undefined); // keep the chain alive on error
    return run;
  }

  private async prompt(request: DiffRequest): Promise<DiffOutcome> {
    const index = ++this.seq;
    let oldExists = true;
    try {
      await fs.stat(request.filePath);
    } catch {
      oldExists = false;
    }
    const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    // `w` re-renders the same diff in the other view, so the pager gets the renderer.
    const render = (view: DiffView, cols: number): Promise<string[]> =>
      this.renderRaw(request, oldExists, cols, view).then((raw) => raw.replace(/\n$/, "").split("\n"));
    const source = await render(this.opts.view, termCols());
    return interactive
      ? this.runPager(request, source, render, index)
      : this.plain(request, source.join("\n"), oldExists);
  }

  // ---- interactive pager (TTY) ---------------------------------------------

  private runPager(
    request: DiffRequest,
    source: string[],
    render: (view: DiffView, cols: number) => Promise<string[]>,
    index: number
  ): Promise<DiffOutcome> {
    const pager = new Pager({
      title: request.tabName,
      subtitle: request.filePath,
      source,
      index,
      view: this.opts.view,
      render,
    });
    this.active = {
      acceptContent: request.newContent,
      settle: (v) => pager.external(v),
    };
    return pager.run().then((verdict) => {
      this.clearActive();
      return verdict === "accept"
        ? { status: "saved", content: request.newContent }
        : { status: "rejected" };
    });
  }

  // ---- non-interactive fallback (piped stdin, e.g. tests) ------------------

  private plain(request: DiffRequest, raw: string, oldExists: boolean): Promise<DiffOutcome> {
    const out = process.stdout;
    out.write(`\n${ansi.bold}${ansi.cyan}${request.tabName}${ansi.reset}\n`);
    out.write(`${ansi.dim}${request.filePath}${oldExists ? "" : " (new file)"}${ansi.reset}\n`);
    out.write(raw.endsWith("\n") ? raw : raw + "\n");
    out.write(
      `${ansi.dim}────${ansi.reset} ` +
        `${ansi.green}[y/⏎] accept${ansi.reset}   ${ansi.red}[n/esc] reject${ansi.reset}\n`
    );
    return new Promise<DiffOutcome>((resolve) => {
      const stdin = process.stdin;
      let done = false;
      const settle = (verdict: Verdict) => {
        if (done) return;
        done = true;
        stdin.removeListener("data", onData);
        stdin.pause();
        this.clearActive();
        resolve(verdict === "accept" ? { status: "saved", content: request.newContent } : { status: "rejected" });
      };
      const onData = (buf: Buffer) => {
        const v = keyVerdict(buf.toString());
        if (v) settle(v);
      };
      this.active = { acceptContent: request.newContent, settle };
      stdin.resume();
      stdin.on("data", onData);
    });
  }

  // ---- rendering ------------------------------------------------------------

  /** Best-available colored diff text: delta → colored git → plain. */
  private async renderRaw(
    request: DiffRequest,
    oldExists: boolean,
    cols: number,
    view: DiffView
  ): Promise<string> {
    const tmp = join(tmpdir(), `aib-${randomUUID()}`);
    await fs.writeFile(tmp, request.newContent, "utf8");
    const left = oldExists ? request.filePath : "/dev/null";
    // histogram lines up reflowed/moved blocks better than the default myers, so a
    // rewrapped paragraph shows as a few changed lines instead of a whole new block.
    const gitDiff = (...opts: string[]) =>
      run("git", ["--no-pager", "diff", "--no-index", "--diff-algorithm=histogram", ...opts, "--", left, tmp]);
    try {
      const plainDiff = await gitDiff();
      if (!plainDiff.trim()) return `${ansi.dim}(no changes)${ansi.reset}`;
      let out: string;
      if (view === "word") {
        // git renders the text once with only the changed words colored — delta can't
        // consume word-diff output, so this view is git's alone (no syntax highlighting).
        out = dropFileHeader(
          await gitDiff("--color=always", "--word-diff=color", "--word-diff-regex=[^[:space:]]+")
        );
      } else
        try {
          // --no-gitconfig ignores the user's delta config so a side-by-side /
          // line-numbers setup can't cram or break a narrow pane; delta renders clean
          // unified output at exactly the pane width. --file-style=omit drops the file
          // header (our title bar already names the file).
          out = await run("delta", ["--no-gitconfig", "--width", String(cols), "--paging=never", "--file-style=omit"], plainDiff);
        } catch {
          // delta absent/failed → colored git diff
          out = dropFileHeader(await gitDiff("--color=always"));
        }
      // both tools print the temp path in headers; show the real file path.
      return out.split(tmp).join(request.filePath);
    } catch (e) {
      this.opts.log.warn(`diff render failed (${String(e)}); showing full new content`);
      return request.newContent
        .split("\n")
        .map((l) => `${ansi.green}+${ansi.reset} ${l}`)
        .join("\n");
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  // ---- resolution entry points ----------------------------------------------
  //
  // A definite accepted/rejected only comes from the viewer's own y/n (via the
  // Pager). Everything below is the diff being resolved on the *claude* side —
  // close_tab (claude sends it for BOTH accept and reject, indistinguishably),
  // a cancel, or the agent disconnecting — so we don't guess a verdict; we mark
  // it "handled in claude".

  /** True while a diff is on screen (the pager owns the terminal — don't write over it). */
  hasActiveDiff(): boolean {
    return this.active !== undefined;
  }

  /** Cancel from the claude side (the diff was resolved there). */
  async rejectActiveDiff(): Promise<boolean> {
    if (!this.active) return false;
    this.active.settle("handled");
    return true;
  }

  /** The agent disconnected (claude quit / pane closed) — distinct from "handled". */
  async disconnectActiveDiff(): Promise<boolean> {
    if (!this.active) return false;
    this.active.settle("closed");
    return true;
  }

  async closeTab(_tabName: string): Promise<void> {
    this.active?.settle("handled");
  }

  async closeAllDiffTabs(): Promise<number> {
    if (!this.active) return 0;
    this.active.settle("handled");
    return 1;
  }

  // ---- stubbed editor queries (a terminal has none of these) ---------------

  getCurrentSelection(): SelectionInfo | null {
    return null;
  }
  getOpenEditors(): OpenEditorInfo[] {
    return [];
  }
  getWorkspaceFolders(): string[] {
    return [this.opts.cwd];
  }
  getDiagnostics(): FileDiagnostics[] {
    return [];
  }
  async openFile(filePath: string): Promise<void> {
    this.opts.log.info(`openFile ignored (terminal frontend): ${filePath}`);
  }
  async saveDocument(): Promise<boolean> {
    return false;
  }
  documentState(): { open: boolean; dirty: boolean; untitled: boolean } {
    return { open: false, dirty: false, untitled: false };
  }
  onSelectionChanged(_listener: (sel: SelectionInfo) => void): Disposable {
    return { dispose: () => undefined };
  }
  onDiagnosticsChanged(_listener: (files: string[]) => void): Disposable {
    return { dispose: () => undefined };
  }
}

// ---- pager ------------------------------------------------------------------

interface PagerView {
  title: string;
  subtitle: string;
  /** Rendered diff lines as the tool emitted them (unwrapped). */
  source: string[];
  index: number;
  view: DiffView;
  /** Re-render the same diff in another view (for the `w` toggle). */
  render: (view: DiffView, cols: number) => Promise<string[]>;
}

/**
 * A minimal scrolling pager on the alternate screen: title bar, scrollable diff
 * body, and a key-hint footer. Keys: j/k line, space/b page, g/G ends,
 * y/⏎ accept, n/esc reject.
 */
class Pager {
  private top = 0;
  private rows = termRows();
  private cols = termCols();
  private done = false;
  private resolve!: (verdict: Verdict) => void;
  /** Rendered lines per view, kept so `w` only pays for each render once. */
  private sources: Partial<Record<DiffView, string[]>>;
  private mode: DiffView;
  private loading = false;
  /** The current source folded to the current width — delta doesn't wrap unified output. */
  private lines: string[];

  constructor(private readonly view: PagerView) {
    this.mode = view.view;
    this.sources = { [view.view]: view.source };
    this.lines = wrapLines(view.source, this.cols);
  }

  run(): Promise<Verdict> {
    const p = new Promise<Verdict>((res) => (this.resolve = res));
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l"); // alt screen, hide cursor, no wrap
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
    this.draw();
    return p;
  }

  /** Resolve from the claude side (close_tab / cancel / disconnect). */
  external = (verdict: Verdict): void => this.finish(verdict);

  private finish(verdict: Verdict): void {
    if (this.done) return;
    this.done = true;
    process.stdin.removeListener("data", this.onData);
    process.stdout.removeListener("resize", this.onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l"); // restore wrap, cursor, main screen
    const label =
      verdict === "accept"
        ? `${ansi.green}✓ accepted${ansi.reset}`
        : verdict === "reject"
        ? `${ansi.red}✗ rejected${ansi.reset}`
        : verdict === "handled"
        ? `${ansi.cyan}· handled${ansi.reset}`
        : `${ansi.yellow}· closed${ansi.reset}`;
    process.stdout.write(`${label} ${ansi.dim}${basename(this.view.subtitle)}${ansi.reset}\n`);
    this.resolve(verdict);
  }

  private viewH(): number {
    return Math.max(1, this.rows - 2); // minus title + footer bars
  }
  private maxTop(): number {
    return Math.max(0, this.lines.length - this.viewH());
  }
  private scroll(delta: number): void {
    this.scrollTo(this.top + delta);
  }
  private scrollTo(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.maxTop()));
    if (clamped !== this.top) {
      this.top = clamped;
      this.draw();
    }
  }

  private source(): string[] {
    return this.sources[this.mode] ?? [];
  }

  /** Swap to `mode`, rendering it on first use; a fresh view starts at the top. */
  private async setMode(mode: DiffView): Promise<void> {
    if (this.loading || mode === this.mode) return;
    if (!this.sources[mode]) {
      this.loading = true;
      this.draw(); // footer shows the pending view while the renderer runs
      try {
        this.sources[mode] = await this.view.render(mode, this.cols);
      } catch {
        this.sources[mode] = [`${ansi.dim}(${mode} view unavailable)${ansi.reset}`];
      }
      this.loading = false;
      if (this.done) return;
    }
    this.mode = mode;
    this.top = 0;
    this.lines = wrapLines(this.source(), this.cols);
    this.draw();
  }

  private onResize = (): void => {
    this.rows = termRows();
    const cols = termCols();
    if (cols !== this.cols) {
      this.cols = cols;
      this.lines = wrapLines(this.source(), cols);
    }
    this.top = Math.min(this.top, this.maxTop());
    this.draw();
  };

  private onData = (buf: Buffer): void => {
    const k = buf.toString();
    const v = keyVerdict(k);
    if (v) return this.finish(v);
    if (k === "j" || k === "\x1b[B") return this.scroll(1);
    if (k === "k" || k === "\x1b[A") return this.scroll(-1);
    if (k === " " || k === "f" || k === "\x1b[6~") return this.scroll(this.viewH());
    if (k === "b" || k === "\x1b[5~") return this.scroll(-this.viewH());
    if (k === "g" || k === "\x1b[H") return this.scrollTo(0);
    if (k === "G" || k === "\x1b[F") return this.scrollTo(this.maxTop());
    if (k === "w") return void this.setMode(this.mode === "line" ? "word" : "line");
  };

  private draw(): void {
    const viewH = this.viewH();
    const more = this.lines.length > viewH;
    const atBottom = this.top >= this.maxTop();
    const pct = !more ? "all" : `${Math.min(100, Math.round(((this.top + viewH) / this.lines.length) * 100))}%`;

    const other = this.mode === "line" ? "word" : "line";
    const top = bar(
      this.view.title,
      `proposed${this.top > 0 ? "  ▲" : ""}`,
      this.cols
    );
    const bottom = bar(
      `[y]accept  [n]reject  [w]${this.loading ? `${other}…` : other}  [j/k·space]scroll`,
      `${pct}  #${this.view.index}${more && !atBottom ? "  ▼" : ""}`,
      this.cols
    );

    let frame = "\x1b[H" + top + "\r\n";
    for (let i = 0; i < viewH; i++) {
      frame += "\x1b[K" + (this.lines[this.top + i] ?? "") + "\r\n";
    }
    frame += `\x1b[${this.rows};1H\x1b[K` + bottom;
    process.stdout.write(frame);
  }
}

// ---- helpers ----------------------------------------------------------------

/** Fold rendered diff lines to `cols`, keeping their order. */
function wrapLines(lines: string[], cols: number): string[] {
  return lines.flatMap((l) => wrapAnsi(l, cols));
}

/** Gutter on wrapped rows, so a folded line doesn't read as another changed line. */
const CONT = `${ansi.dim}↳${ansi.reset} `;
const CONT_W = 2;

/**
 * Split one rendered line into pane-wide pieces. delta only wraps in side-by-side
 * mode, and the pager runs with autowrap off, so without this a long line (a big
 * yaml value, a minified blob) is simply clipped at the pane edge. Escape sequences
 * cost no columns and the active SGR state is re-opened on each continuation, so
 * delta's colors and word-diff backgrounds survive the break.
 */
function wrapAnsi(line: string, cols: number): string[] {
  if (cols <= CONT_W + 1) return [line];
  const out: string[] = [];
  let seg = "";
  let sgr = ""; // styling in effect, re-emitted at the start of each continuation
  let width = 0;
  let limit = cols; // continuations lose the columns the ↳ gutter takes
  for (let i = 0; i < line.length; ) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !/[@-~]/.test(line[j])) j++;
      const esc = line.slice(i, j + 1);
      seg += esc;
      if (esc.endsWith("m")) sgr = /^\x1b\[0?m$/.test(esc) ? "" : sgr + esc;
      i = j + 1;
      continue;
    }
    if (width === limit) {
      out.push(sgr ? seg + ansi.reset : seg);
      seg = CONT + sgr;
      width = 0;
      limit = cols - CONT_W;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    seg += ch;
    width += 1;
    i += ch.length;
  }
  out.push(seg);
  return out;
}

/** Drop git's `diff --git` / `index` / `---` / `+++` preamble — the title bar names the file. */
function dropFileHeader(out: string): string {
  const lines = out.split("\n");
  const first = lines.findIndex((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").startsWith("@@"));
  return first > 0 ? lines.slice(first).join("\n") : out;
}

/** A reverse-video status bar: left text, right text, padded to `cols`. */
function bar(left: string, right: string, cols: number): string {
  const l = ` ${left}`;
  const r = `${right} `;
  const pad = Math.max(1, cols - l.length - r.length);
  let s = l + " ".repeat(pad) + r;
  if (s.length > cols) s = s.slice(0, cols);
  return `\x1b[7m${s}\x1b[0m`;
}

/** Map a keystroke to an accept/reject verdict, or null if it's neither. */
function keyVerdict(k: string): "accept" | "reject" | null {
  if (k === "y" || k === "Y" || k === "\r" || k === "\n") return "accept";
  if (k === "n" || k === "N" || k === "q" || k === "\x03" || k === "\x1b") return "reject";
  return null;
}

/**
 * Run a command and resolve its stdout, ignoring a non-zero exit (git diff returns
 * 1 when files differ). With `input`, pipe it to stdin. Rejects if the command is
 * missing (used to fall back from delta to git).
 */
function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input == null ? "ignore" : "pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    if (input != null) {
      child.stdin?.on("error", () => undefined); // ignore EPIPE if the tool exits early
      child.stdin?.end(input);
    }
  });
}

/** Terminal size, falling back to COLUMNS/LINES env then sane defaults (herdr panes can report 0). */
function termCols(): number {
  return process.stdout.columns || Number(process.env.COLUMNS) || 80;
}
function termRows(): number {
  return process.stdout.rows || Number(process.env.LINES) || 24;
}
