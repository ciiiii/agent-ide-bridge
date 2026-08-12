import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory the Claude CLI scans to discover running IDEs. */
export function lockDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(base, "ide");
}

export interface LockInfo {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: "ws";
  runningInWindows: boolean;
  authToken: string;
}

/**
 * Write ~/.claude/ide/<port>.lock so `claude` (and /ide) can discover and
 * authenticate to this window's WebSocket server. Mirrors the official
 * extension's lockfile exactly (pid = process.ppid; ideName = appName), so the
 * stock CLI discovers/matches it identically. Returns the auth token clients
 * must present in the AUTH_HEADER.
 */
export function writeLock(
  port: number,
  workspaceFolders: string[],
  ideName: string
): { path: string; authToken: string } {
  const authToken = randomUUID();
  const info: LockInfo = {
    pid: process.ppid, // the CLI matches the lock to its parent shell pid
    workspaceFolders,
    ideName,
    transport: "ws",
    runningInWindows: process.platform === "win32",
    authToken,
  };
  mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
  const path = join(lockDir(), `${port}.lock`);
  writeFileSync(path, JSON.stringify(info), { mode: 0o600 });
  return { path, authToken };
}

export function removeLock(port: number): void {
  try {
    rmSync(join(lockDir(), `${port}.lock`), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Remove lockfiles whose owning process is gone (e.g. left behind when a prior
 * code-server was killed without a clean deactivate). Otherwise the CLI/`/ide`
 * can try to connect to a dead port. A lock is stale iff its `pid` no longer
 * exists; `EPERM` means the process is alive but not ours, so we keep it.
 */
export function cleanupStaleLocks(): void {
  let files: string[];
  try {
    files = readdirSync(lockDir());
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".lock")) continue;
    const full = join(lockDir(), f);
    try {
      const info = JSON.parse(readFileSync(full, "utf8")) as Partial<LockInfo>;
      if (typeof info.pid !== "number") continue;
      try {
        process.kill(info.pid, 0); // alive (or EPERM) → keep
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          rmSync(full, { force: true }); // owner gone → remove
        }
      }
    } catch {
      /* unreadable/partial lock — leave it alone */
    }
  }
}
