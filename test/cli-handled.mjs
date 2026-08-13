// Claude-side resolution: when the user accepts/rejects in the claude pane (not the
// viewer), claude sends close_tab with no reliable accept-vs-reject signal — so the
// viewer must NOT claim accepted or rejected; it shows a neutral "handled in claude".
// Run: node test/cli-handled.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cli, connect, handshake, loadPty, repoRoot, strip, texts, tmpDirs, waitForLock } from "./harness.mjs";

const pty = loadPty();
if (!pty) {
  console.log("SKIP: node-pty not installed");
  process.exit(0);
}

const { cfg, wsDir, cleanup } = tmpDirs();
const file = join(wsDir, "hello.txt");
writeFileSync(file, "line one\nline two\n", "utf8");

const child = pty.spawn("node", [cli, "--port", "0", "--dir", wsDir], {
  name: "xterm-256color", cols: 100, rows: 30, cwd: repoRoot,
  env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
});
let out = "";
child.onData((d) => (out += d));
const fail = (m) => {
  console.error("FAIL:", m, "\n" + strip(out));
  try { child.kill(); } catch {}
  cleanup();
  process.exit(1);
};
setTimeout(() => fail("timeout"), 10000);

const { port, authToken } = await waitForLock(cfg);
const conn = await connect({ port, authToken, wsDir });
await handshake(conn, "handled-e2e");

const diffP = conn.rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: "line one\nline two changed\n", tab_name: "✻ hello.txt" },
});
await sleep(500);
if (!out.includes("\x1b[?1049h")) fail("diff did not open (no alt-screen)");

// resolve on the claude side (no viewer keypress)
await conn.rpc("tools/call", { name: "close_tab", arguments: { tab_name: "✻ hello.txt" } });

const t = texts(await diffP);
if (t[0] !== "DIFF_REJECTED") fail(`close_tab should return DIFF_REJECTED over the wire, got ${JSON.stringify(t)}`);
await sleep(150);
const clean = strip(out);
if (!/handled hello\.txt/.test(clean)) fail("viewer did not show '· handled'");
if (/accepted/.test(clean) || /rejected/.test(clean)) fail("viewer wrongly claimed a definite verdict");
if (!out.includes("\x1b[?1049l")) fail("pager did not leave the alternate screen");

console.log("PASS: close_tab (claude-side) → '· handled', no accepted/rejected guess");
conn.sock.close();
child.kill();
cleanup();
process.exit(0);
