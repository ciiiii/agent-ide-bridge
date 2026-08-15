import { resolve } from "node:path";
import { ClaudeAdapter } from "../adapters/claude/server";
import { Logger } from "../core/types";
import { DiffView, TerminalDiffFrontend, ansi } from "./terminalFrontend";

interface Args {
  port: number;
  dir: string;
  ideName: string;
  verbose: boolean;
  idleExit: number; // seconds after the last client disconnects before exiting; 0 = never
  view: DiffView; // diff rendering the pager opens with; toggled live with `w`
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    port: 8991,
    dir: process.cwd(),
    ideName: "terminal",
    verbose: false,
    idleExit: 0,
    view: process.env.AIB_DIFF_VIEW === "word" ? "word" : "line",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") a.port = Number(argv[++i]);
    else if (arg === "--dir" || arg === "-C") a.dir = argv[++i];
    else if (arg === "--ide-name") a.ideName = argv[++i];
    else if (arg === "--idle-exit") a.idleExit = Number(argv[++i]);
    else if (arg === "--diff-view") a.view = argv[++i] === "word" ? "word" : "line";
    else if (arg === "--verbose" || arg === "-v") a.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!Number.isFinite(a.port)) a.port = 8991;
  if (!Number.isFinite(a.idleExit)) a.idleExit = 0;
  a.dir = resolve(a.dir); // lockfile workspaceFolders / /ide need an absolute path
  return a;
}

function printHelp(): void {
  process.stdout.write(
    `claude-diff — terminal diff frontend for the Claude IDE protocol\n\n` +
      `Usage: claude-diff [options]\n\n` +
      `  -p, --port <n>     preferred localhost port (default 8991, 0 = random)\n` +
      `  -C, --dir <path>   workspace folder to advertise (default cwd)\n` +
      `      --ide-name <s>  IDE name in the lockfile (default "terminal")\n` +
      `      --idle-exit <s> exit N seconds after the last client disconnects (0 = never)\n` +
      `      --diff-view <line|word>  initial diff rendering, toggled with w (default line;\n` +
      `                        env AIB_DIFF_VIEW)\n` +
      `  -v, --verbose      log protocol traffic to stderr\n` +
      `  -h, --help          show this help\n`
  );
}

/** Quiet by default: warnings/errors to stderr; info/trace only with --verbose. */
function makeLogger(verbose: boolean): Logger {
  const w = (m: string) => process.stderr.write(m + "\n");
  return {
    info: (m) => verbose && w(`[info] ${m}`),
    warn: (m) => w(`[warn] ${m}`),
    error: (m) => w(`[error] ${m}`),
    trace: (m) => verbose && w(`[trace] ${m}`),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = makeLogger(args.verbose);
  const frontend = new TerminalDiffFrontend({ cwd: args.dir, log, view: args.view });
  const adapter = new ClaudeAdapter(frontend, {
    port: args.port,
    ideName: args.ideName,
    log,
  });

  await adapter.start();
  const port = adapter.port;
  process.stdout.write(
    `${ansi.bold}claude-diff${ansi.reset} listening on 127.0.0.1:${port}  (workspace: ${args.dir})\n` +
      `${ansi.dim}In your claude pane:  export CLAUDE_CODE_SSE_PORT=${port}   then run  claude\n` +
      `(or run claude and use /ide to pick this session)${ansi.reset}\n`
  );

  const shutdown = () => {
    adapter.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // React to the agent disconnecting (claude quit / pane closed):
  //  - resolve any diff still awaiting a verdict, so the viewer doesn't sit frozen
  //    on a diff whose agent is gone (claude may drop the socket without cancelling);
  //  - if --idle-exit is set, exit after a grace period so herdr closes this pane.
  // The grace absorbs brief drops (e.g. a reconnect via /ide).
  let everConnected = false;
  let clientCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  adapter.onClientsChanged(() => {
    const gained = adapter.clientCount > clientCount;
    clientCount = adapter.clientCount;
    if (clientCount > 0) {
      everConnected = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      // Counterpart to the disconnect cue, so the pane confirms /ide worked instead of
      // just sitting on its banner. Skipped while a diff holds the alternate screen —
      // a stray write there would smear the pager frame. (This fires on the socket, so
      // the session's own name isn't known yet; the count is enough of a cue.)
      if (gained && !frontend.hasActiveDiff()) {
        const extra = clientCount > 1 ? ` ${ansi.dim}(${clientCount} sessions)${ansi.reset}` : "";
        process.stdout.write(`${ansi.green}· claude connected${ansi.reset}${extra}\n`);
      }
      return;
    }
    if (!everConnected) return;
    // Resolve any open diff as "closed"; if none was open, print a session-level
    // disconnect cue so the pane isn't just silently auto-closed.
    void frontend.disconnectActiveDiff().then((hadDiff) => {
      if (!hadDiff) {
        const note = args.idleExit > 0 ? ` ${ansi.dim}(closing in ${args.idleExit}s)${ansi.reset}` : "";
        process.stdout.write(`\n${ansi.yellow}· claude disconnected${ansi.reset}${note}\n`);
      }
    });
    if (args.idleExit > 0 && !idleTimer) {
      idleTimer = setTimeout(() => {
        log.info("last client disconnected; exiting");
        shutdown();
      }, args.idleExit * 1000);
    }
  });
}

main().catch((err) => {
  process.stderr.write(`claude-diff failed to start: ${String(err)}\n`);
  process.exit(1);
});
