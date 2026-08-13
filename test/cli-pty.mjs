// Interactive e2e for the CLI's diff pager. Unlike test/cli.mjs (piped, non-TTY,
// exercises the plain path), this allocates a real PTY via node-pty so the CLI
// takes the alt-screen Pager path, then drives it: openDiff over WS, scroll with
// `j`/`G`, accept with `y`, and assert the pager rendered + returned FILE_SAVED.
//
// Run: node test/cli-pty.mjs   (needs the node-pty devDependency)
import { createRequire } from "node:module";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
let pty;
try {
  // node-pty's prebuilt spawn-helper can ship non-executable (mode 644), which
  // makes pty.spawn fail with "posix_spawnp failed" — restore the exec bit.
  const ptyDir = dirname(require.resolve("node-pty/package.json"));
  const helper = join(ptyDir, `prebuilds/${process.platform}-${process.arch}/spawn-helper`);
  if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
} catch {}
try {
  pty = require("node-pty");
} catch {
  console.log("SKIP: node-pty not installed (npm i -D node-pty)");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = mkdtempSync(join(tmpdir(), "aib-cfg-"));
const wsDir = mkdtempSync(join(tmpdir(), "aib-ws-"));
const file = join(wsDir, "big.txt");
const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
writeFileSync(file, oldLines.join("\n") + "\n", "utf8");
// change one line, insert another → a diff taller than an 80x24 viewport
const newLines = [...oldLines];
newLines[1] = "line 2 changed";
newLines.splice(20, 0, "inserted line");
const newContent = newLines.join("\n") + "\n";

// A real pty so the CLI sees isTTY=true on both ends and takes the Pager path.
const child = pty.spawn("node", [join(root, "dist/cli.js"), "--port", "0", "--dir", wsDir], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: root,
  env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
});
let out = "";
child.onData((d) => (out += d));

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
function cleanup() {
  rmSync(cfg, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
}
function fail(msg) {
  console.error("FAIL:", msg);
  console.error("--- pty output (stripped) ---\n" + strip(out));
  child.kill();
  cleanup();
  process.exit(1);
}

const ideDir = join(cfg, "ide");
let lock, port, authToken;
for (let i = 0; i < 50; i++) {
  try {
    const f = readdirSync(ideDir).find((x) => x.endsWith(".lock"));
    if (f) {
      port = f.replace(".lock", "");
      ({ authToken } = JSON.parse(readFileSync(join(ideDir, f), "utf8")));
      lock = f;
      break;
    }
  } catch {}
  await sleep(100);
}
if (!lock) fail("no lockfile written");
console.log(`lock: ${lock}  port=${port}  (pty)`);

const sock = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { "x-claude-code-ide-authorization": authToken },
});
const pending = new Map();
let seq = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = `c${++seq}`;
    pending.set(id, resolve);
    sock.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });

sock.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "roots/list") {
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { roots: [{ uri: `file://${wsDir}` }] } }));
  }
});

sock.on("open", async () => {
  await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "pty-e2e", version: "1" } });
  sock.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  const tabName = "✻ [Claude Code] big.txt";
  const diffP = rpc("tools/call", {
    name: "openDiff",
    arguments: { old_file_path: file, new_file_path: file, new_file_contents: newContent, tab_name: tabName },
  });

  await sleep(600); // let the pager draw
  if (!out.includes("\x1b[?1049h")) fail("pager did not enter the alternate screen");
  const frame = strip(out);
  if (!/\[y\]accept/.test(frame)) fail("footer key hints not rendered");
  if (!/big\.txt/.test(frame)) fail("title bar not rendered");
  if (!/line 2 changed/.test(frame)) fail("diff body not rendered");

  child.write("j"); // scroll down a line
  child.write("G"); // jump to bottom
  await sleep(200);
  child.write("y"); // accept

  const res = await diffP;
  const texts = (res.result?.content ?? []).map((c) => c.text);
  if (texts[0] !== "FILE_SAVED") fail(`expected FILE_SAVED, got ${JSON.stringify(texts)}`);
  if (texts[1] !== newContent) fail("accepted content mismatch");
  await sleep(150);
  if (!out.includes("\x1b[?1049l")) fail("pager did not leave the alternate screen");
  if (!/✓ accepted/.test(strip(out))) fail("no accept confirmation line");

  console.log("PASS: pager rendered on alt-screen, scrolled, y-accepted → FILE_SAVED");
  sock.close();
  child.kill();
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 10000);
