import { resolve } from "node:path";
import { ClaudeAdapter } from "../adapters/claude/server";
import { Logger } from "../core/types";
import { TerminalDiffFrontend } from "./terminalFrontend";

interface Args {
  port: number;
  dir: string;
  ideName: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { port: 8991, dir: process.cwd(), ideName: "terminal", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") a.port = Number(argv[++i]);
    else if (arg === "--dir" || arg === "-C") a.dir = argv[++i];
    else if (arg === "--ide-name") a.ideName = argv[++i];
    else if (arg === "--verbose" || arg === "-v") a.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!Number.isFinite(a.port)) a.port = 8991;
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
  const frontend = new TerminalDiffFrontend({ cwd: args.dir, log });
  const adapter = new ClaudeAdapter(frontend, {
    port: args.port,
    ideName: args.ideName,
    log,
  });

  await adapter.start();
  const port = adapter.port;
  process.stdout.write(
    `\x1b[1mclaude-diff\x1b[0m listening on 127.0.0.1:${port}  (workspace: ${args.dir})\n` +
      `\x1b[2mIn your claude pane:  export CLAUDE_CODE_SSE_PORT=${port}   then run  claude\n` +
      `(or run claude and use /ide to pick this session)\x1b[0m\n`
  );

  const shutdown = () => {
    adapter.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`claude-diff failed to start: ${String(err)}\n`);
  process.exit(1);
});
