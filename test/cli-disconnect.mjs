// Regression: quitting claude while a diff is open must close the diff (not sit
// frozen) and let the viewer exit. Open a diff in a pty, drop the WS, assert the
// pager tears down (✗ rejected, leaves alt-screen) and the process exits.
// Run: node test/cli-disconnect.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cli, connect, handshake, loadPty, repoRoot, strip, tmpDirs, waitForLock } from "./harness.mjs";

const pty = loadPty();
if (!pty) {
  console.log("SKIP: node-pty not installed");
  process.exit(0);
}

const { cfg, wsDir, cleanup } = tmpDirs();
const file = join(wsDir, "hello.txt");
writeFileSync(file, "line one\nline two\n", "utf8");

// --idle-exit 1 so the pane-exit path is fast to observe.
const child = pty.spawn("node", [cli, "--port", "0", "--dir", wsDir, "--idle-exit", "1"], {
  name: "xterm-256color", cols: 100, rows: 30, cwd: repoRoot,
  env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
});
let out = "";
let exited = false;
child.onData((d) => (out += d));
child.onExit(() => (exited = true));
const fail = (m) => {
  console.error("FAIL:", m, "\n" + strip(out));
  try { child.kill(); } catch {}
  cleanup();
  process.exit(1);
};
setTimeout(() => fail("timeout"), 12000);

const { port, authToken } = await waitForLock(cfg);
const conn = await connect({ port, authToken, wsDir });
await handshake(conn, "disc-e2e");

conn.rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: "line one\nline two changed\n", tab_name: "✻ hello.txt" },
}); // don't await — we'll drop the socket instead of responding
await sleep(500);
if (!out.includes("\x1b[?1049h")) fail("diff did not open (no alt-screen)");

conn.sock.terminate(); // simulate quitting claude: drop the socket abruptly

await sleep(700);
if (!/handled in claude/.test(strip(out))) fail("diff was not closed as handled on disconnect");
if (!out.includes("\x1b[?1049l")) fail("pager did not leave the alternate screen on disconnect");

for (let i = 0; i < 20 && !exited; i++) await sleep(100); // idle-exit (1s) → process exits
if (!exited) fail("viewer did not exit after the agent disconnected");

console.log("PASS: disconnect → diff closed (handled in claude, alt-screen left) → viewer exited");
cleanup();
process.exit(0);
