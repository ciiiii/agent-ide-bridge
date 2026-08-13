// Reject path: drive the pager, press `n`, assert openDiff returns DIFF_REJECTED
// and the viewer shows "✗ rejected". Run: node test/cli-reject.mjs
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
await handshake(conn, "reject-e2e");

const diffP = conn.rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: "line one\nline two changed\n", tab_name: "✻ hello.txt" },
});
await sleep(500);
child.write("n"); // REJECT
const t = texts(await diffP);
if (t[0] !== "DIFF_REJECTED") fail(`expected DIFF_REJECTED, got ${JSON.stringify(t)}`);
await sleep(150);
if (!/✗ rejected/.test(strip(out))) fail("viewer did not show ✗ rejected");

console.log("PASS: n → DIFF_REJECTED, viewer shows ✗ rejected");
conn.sock.close();
child.kill();
cleanup();
process.exit(0);
