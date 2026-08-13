import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

interface ActiveDiff {
  acceptContent: string;
  settle: (outcome: DiffOutcome) => void;
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

  constructor(private readonly opts: { cwd: string; log: Logger }) {}

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
    const cols = (interactive && process.stdout.columns) || 100;
    const raw = await this.renderRaw(request, oldExists, cols);
    return interactive
      ? this.runPager(request, raw, index)
      : this.plain(request, raw, oldExists);
  }

  // ---- interactive pager (TTY) ---------------------------------------------

  private runPager(request: DiffRequest, raw: string, index: number): Promise<DiffOutcome> {
    const pager = new Pager({
      title: request.tabName,
      subtitle: request.filePath,
      lines: raw.replace(/\n$/, "").split("\n"),
      index,
    });
    this.active = {
      acceptContent: request.newContent,
      settle: (o) => (o.status === "saved" ? pager.acceptExternal() : pager.rejectExternal()),
    };
    return pager.run().then((verdict) => {
      this.active = undefined;
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
      const settle = (outcome: DiffOutcome) => {
        if (done) return;
        done = true;
        stdin.removeListener("data", onData);
        stdin.pause();
        this.active = undefined;
        resolve(outcome);
      };
      const onData = (buf: Buffer) => {
        const k = buf.toString();
        if (k === "y" || k === "Y" || k === "\r" || k === "\n")
          settle({ status: "saved", content: request.newContent });
        else if (k === "n" || k === "N" || k === "\x1b" || k === "q" || k === "\x03")
          settle({ status: "rejected" });
      };
      this.active = { acceptContent: request.newContent, settle };
      stdin.resume();
      stdin.on("data", onData);
    });
  }

  // ---- rendering ------------------------------------------------------------

  /** Best-available colored diff text: delta → colored git → plain. */
  private async renderRaw(request: DiffRequest, oldExists: boolean, cols: number): Promise<string> {
    const tmp = join(tmpdir(), `aib-${randomUUID()}`);
    await fs.writeFile(tmp, request.newContent, "utf8");
    const left = oldExists ? request.filePath : "/dev/null";
    try {
      const plainDiff = await capture("git", ["--no-pager", "diff", "--no-index", "--", left, tmp]);
      if (!plainDiff.trim()) return `${ansi.dim}(no changes)${ansi.reset}`;
      let out: string;
      try {
        out = await pipeInput(plainDiff, "delta", [
          "--width",
          String(cols),
          "--paging=never",
          "--file-style=omit", // our title bar already names the file
        ]);
      } catch {
        // delta absent/failed → colored git diff
        out = await capture("git", [
          "--no-pager",
          "diff",
          "--no-index",
          "--color=always",
          "--",
          left,
          tmp,
        ]);
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

  // ---- accept/reject entry points ------------------------------------------

  async acceptActiveDiff(): Promise<boolean> {
    if (!this.active) return false;
    this.active.settle({ status: "saved", content: this.active.acceptContent });
    return true;
  }

  async rejectActiveDiff(): Promise<boolean> {
    if (!this.active) return false;
    this.active.settle({ status: "rejected" });
    return true;
  }

  /** Closing a diff accepts it, matching the VS Code frontend's close_tab semantics. */
  async closeTab(_tabName: string): Promise<void> {
    if (this.active) this.active.settle({ status: "saved", content: this.active.acceptContent });
  }

  async closeAllDiffTabs(): Promise<number> {
    if (!this.active) return 0;
    this.active.settle({ status: "saved", content: this.active.acceptContent });
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
  lines: string[];
  index: number;
}

/**
 * A minimal scrolling pager on the alternate screen: title bar, scrollable diff
 * body, and a key-hint footer. Keys: j/k line, space/b page, g/G ends,
 * y/⏎ accept, n/esc reject.
 */
class Pager {
  private top = 0;
  private rows = process.stdout.rows || 24;
  private cols = process.stdout.columns || 80;
  private done = false;
  private resolve!: (verdict: "accept" | "reject") => void;

  constructor(private readonly view: PagerView) {}

  run(): Promise<"accept" | "reject"> {
    const p = new Promise<"accept" | "reject">((res) => (this.resolve = res));
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l"); // alt screen, hide cursor, no wrap
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
    this.draw();
    return p;
  }

  acceptExternal = (): void => this.finish("accept");
  rejectExternal = (): void => this.finish("reject");

  private finish(verdict: "accept" | "reject"): void {
    if (this.done) return;
    this.done = true;
    process.stdin.removeListener("data", this.onData);
    process.stdout.removeListener("resize", this.onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l"); // restore wrap, cursor, main screen
    process.stdout.write(
      verdict === "accept"
        ? `${ansi.green}✓ accepted${ansi.reset} ${ansi.dim}${this.view.subtitle}${ansi.reset}\n`
        : `${ansi.red}✗ rejected${ansi.reset} ${ansi.dim}${this.view.subtitle}${ansi.reset}\n`
    );
    this.resolve(verdict);
  }

  private viewH(): number {
    return Math.max(1, this.rows - 2); // minus title + footer bars
  }
  private maxTop(): number {
    return Math.max(0, this.view.lines.length - this.viewH());
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

  private onResize = (): void => {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.top = Math.min(this.top, this.maxTop());
    this.draw();
  };

  private onData = (buf: Buffer): void => {
    const k = buf.toString();
    if (k === "y" || k === "Y" || k === "\r" || k === "\n") return this.finish("accept");
    if (k === "n" || k === "N" || k === "q" || k === "\x03" || k === "\x1b") return this.finish("reject");
    if (k === "j" || k === "\x1b[B") return this.scroll(1);
    if (k === "k" || k === "\x1b[A") return this.scroll(-1);
    if (k === " " || k === "f" || k === "\x1b[6~") return this.scroll(this.viewH());
    if (k === "b" || k === "\x1b[5~") return this.scroll(-this.viewH());
    if (k === "g" || k === "\x1b[H") return this.scrollTo(0);
    if (k === "G" || k === "\x1b[F") return this.scrollTo(this.maxTop());
  };

  private draw(): void {
    const viewH = this.viewH();
    const more = this.view.lines.length > viewH;
    const atBottom = this.top >= this.maxTop();
    const pct = !more ? "all" : `${Math.min(100, Math.round(((this.top + viewH) / this.view.lines.length) * 100))}%`;

    const top = bar(
      this.view.title,
      `proposed${this.top > 0 ? "  ▲" : ""}`,
      this.cols
    );
    const bottom = bar(
      "[y]accept  [n]reject  [j/k·space]scroll",
      `${pct}  #${this.view.index}${more && !atBottom ? "  ▼" : ""}`,
      this.cols
    );

    let frame = "\x1b[H" + top + "\r\n";
    for (let i = 0; i < viewH; i++) {
      frame += "\x1b[K" + (this.view.lines[this.top + i] ?? "") + "\r\n";
    }
    frame += `\x1b[${this.rows};1H\x1b[K` + bottom;
    process.stdout.write(frame);
  }
}

// ---- helpers ----------------------------------------------------------------

/** A reverse-video status bar: left text, right text, padded to `cols`. */
function bar(left: string, right: string, cols: number): string {
  const l = ` ${left}`;
  const r = `${right} `;
  const pad = Math.max(1, cols - l.length - r.length);
  let s = l + " ".repeat(pad) + r;
  if (s.length > cols) s = s.slice(0, cols);
  return `\x1b[7m${s}\x1b[0m`;
}

/** Run a command, resolve its stdout, ignore a non-zero exit (git diff returns 1). */
function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

/** Pipe `input` into a command's stdin and resolve its stdout. Rejects if the command is missing. */
function pipeInput(input: string, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.on("error", () => undefined); // ignore EPIPE if the tool exits early
    child.stdin.end(input);
  });
}
