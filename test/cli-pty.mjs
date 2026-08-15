// Interactive e2e for the diff pager: a real pty makes the CLI take the alt-screen
// Pager path; drive it (openDiff over WS, scroll j/G, accept y) and assert it
// rendered and returned FILE_SAVED. Run: node test/cli-pty.mjs
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
const file = join(wsDir, "big.txt");
const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
writeFileSync(file, oldLines.join("\n") + "\n", "utf8");
// change one line + insert another → a diff taller than a 30-row viewport
const newLines = [...oldLines];
newLines[1] = "line 2 changed";
// wider than the 100-col pty: must be wrapped, not clipped, so the tail stays readable
newLines.splice(20, 0, "inserted line " + "x".repeat(200) + " TAILMARK");
const newContent = newLines.join("\n") + "\n";

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
console.log(`port=${port} (pty)`);
const conn = await connect({ port, authToken, wsDir });
await handshake(conn, "pty-e2e");

const diffP = conn.rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: newContent, tab_name: "✻ [Claude Code] big.txt" },
});
await sleep(600);
if (!out.includes("\x1b[?1049h")) fail("pager did not enter the alternate screen");
const frame = strip(out);
if (!/\[y\]accept/.test(frame)) fail("footer key hints not rendered");
if (!/big\.txt/.test(frame)) fail("title bar not rendered");
if (!/line 2 changed/.test(frame)) fail("diff body not rendered");

child.write("j"); // scroll a line
child.write("G"); // jump to bottom
await sleep(200);
// the pty stream holds whatever was written, so clipping only shows up as an
// over-wide row: every emitted row must fit the 100-col pane, and the long line's
// tail must still be present (wrapped onto continuation rows).
const rows = strip(out.slice(out.indexOf("\x1b[?1049h"))).split(/\r*\n/);
const over = rows.find((r) => r.length > 100);
if (over) fail(`row wider than the pane (${over.length} cols): ${JSON.stringify(over)}`);
if (!rows.some((r) => r.includes("TAILMARK"))) fail("long line's tail is missing");
if (!rows.some((r) => r.startsWith("↳ "))) fail("wrapped rows lack the ↳ continuation gutter");

// w → git word-diff view (the whole change shown once, changed words colored), w back
const beforeWord = out.length;
child.write("w");
await sleep(600);
const word = strip(out.slice(beforeWord));
if (!/\[w\]line/.test(word)) fail("footer did not flip to the line-view hint");
if (!/@@ /.test(word)) fail("word-diff body not rendered");
if (/^diff --git/m.test(word)) fail("word-diff kept git's file header");
const beforeBack = out.length;
child.write("w");
await sleep(300);
if (!/\[w\]word/.test(strip(out.slice(beforeBack)))) fail("w did not toggle back to the line view");

child.write("y"); // accept

const t = texts(await diffP);
if (t[0] !== "FILE_SAVED") fail(`expected FILE_SAVED, got ${JSON.stringify(t)}`);
if (t[1] !== newContent) fail("accepted content mismatch");
await sleep(150);
if (!out.includes("\x1b[?1049l")) fail("pager did not leave the alternate screen");
if (!/✓ accepted/.test(strip(out))) fail("no accept confirmation line");

console.log("PASS: pager rendered on alt-screen, scrolled, y-accepted → FILE_SAVED");
conn.sock.close();
child.kill();
cleanup();
process.exit(0);
