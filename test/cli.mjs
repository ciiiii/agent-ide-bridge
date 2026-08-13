// e2e (non-TTY plain path): handshake, workspace folders, openDiff renders, accept
// via a `y` keystroke → FILE_SAVED, and close_tab on a pending diff → DIFF_REJECTED.
// Run: node test/cli.mjs  (after: npm run build)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cli, connect, handshake, strip, texts, tmpDirs, waitForLock } from "./harness.mjs";

const { cfg, wsDir, cleanup } = tmpDirs();
const file = join(wsDir, "hello.txt");
writeFileSync(file, "line one\nline two\nline four\nline five\n", "utf8");

const child = spawn("node", [cli, "--port", "0", "--dir", wsDir], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
  stdio: ["pipe", "pipe", "pipe"], // stdin piped so we can accept via a keystroke
});
let cliOut = "";
child.stdout.on("data", (d) => (cliOut += d));
child.stderr.on("data", (d) => (cliOut += d));
const fail = (m) => {
  console.error("FAIL:", m, "\n--- cli output ---\n" + cliOut);
  child.kill();
  cleanup();
  process.exit(1);
};
setTimeout(() => fail("timeout"), 8000);

const { port, authToken } = await waitForLock(cfg);
console.log(`port=${port}`);
const conn = await connect({ port, authToken, wsDir });
await handshake(conn, "cli-e2e");

const wf = await conn.rpc("tools/call", { name: "getWorkspaceFolders", arguments: {} });
if (!JSON.parse(wf.result.content[0].text).folders.some((f) => f.path === wsDir))
  fail("getWorkspaceFolders did not include --dir");

// 1) accept via keystroke
const newContent = "line one\nline two changed\nline three\nline four\nline five\n";
const diffP = conn.rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: newContent, tab_name: "✻ hello.txt" },
});
await sleep(400);
const clean = strip(cliOut);
if (!/changed/.test(clean) || !/line three/.test(clean)) fail("diff was not rendered");
child.stdin.write("y");
const t1 = texts(await diffP);
if (t1[0] !== "FILE_SAVED") fail(`expected FILE_SAVED, got ${JSON.stringify(t1)}`);
if (t1[1] !== newContent) fail("accepted content mismatch");

// Resolved on the CLAUDE side — the CLI never guesses accept-vs-reject here (claude
// sends close_tab for both, indistinguishably), so it returns DIFF_REJECTED over the
// wire and shows "handled in claude" (display checked in cli-handled.mjs). A definite
// accepted/rejected only comes from the viewer's y/n (cli-pty.mjs / cli-reject.mjs).

// 2) close_tab → handled → DIFF_REJECTED
const diff2 = conn.rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: "changed again\n", tab_name: "✻ hello.txt #2" },
});
await sleep(300);
await conn.rpc("tools/call", { name: "close_tab", arguments: { tab_name: "✻ hello.txt #2" } });
const t2 = texts(await diff2);
if (t2[0] !== "DIFF_REJECTED") fail(`close_tab should resolve handled→rejected, got ${JSON.stringify(t2)}`);

// 3) cancel → handled → DIFF_REJECTED
const diff3 = conn.rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: "changed thrice\n", tab_name: "✻ hello.txt #3" },
});
await sleep(300);
conn.notify("notifications/cancelled", { requestId: "x", reason: "user rejected" });
const t3 = texts(await diff3);
if (t3[0] !== "DIFF_REJECTED") fail(`cancel should resolve handled→rejected, got ${JSON.stringify(t3)}`);

console.log("PASS: y→saved, close_tab→handled, cancel→handled, workspace folders");
conn.sock.close();
child.kill();
cleanup();
process.exit(0);
