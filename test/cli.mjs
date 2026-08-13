// End-to-end test for the terminal CLI (dist/cli.js): spawn it with an isolated
// CLAUDE_CONFIG_DIR, connect over WS, initialize, openDiff, and accept via
// close_tab — asserting the diff renders and openDiff returns FILE_SAVED with the
// proposed content. Run: node test/cli.mjs   (after: npm run build)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = mkdtempSync(join(tmpdir(), "aib-cfg-"));
const wsDir = mkdtempSync(join(tmpdir(), "aib-ws-"));
const file = join(wsDir, "hello.txt");
writeFileSync(file, "line one\nline two\nline four\nline five\n", "utf8");

const child = spawn("node", [join(root, "dist/cli.js"), "--port", "0", "--dir", wsDir], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
  stdio: ["ignore", "pipe", "pipe"],
});
let cliOut = "";
child.stdout.on("data", (d) => (cliOut += d.toString()));
child.stderr.on("data", (d) => (cliOut += d.toString()));

function cleanup() {
  rmSync(cfg, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
}
function fail(msg) {
  console.error("FAIL:", msg);
  console.error("--- cli output ---\n" + cliOut);
  child.kill();
  cleanup();
  process.exit(1);
}

// wait for the lockfile
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
console.log(`lock: ${lock}  port=${port}`);

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
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "cli-e2e", version: "1" },
  });
  if (!init.result?.serverInfo) fail("initialize returned no serverInfo");
  sock.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  // workspace folder should be reported from --dir
  const wf = await rpc("tools/call", { name: "getWorkspaceFolders", arguments: {} });
  if (!JSON.parse(wf.result.content[0].text).folders.some((f) => f.path === wsDir))
    fail("getWorkspaceFolders did not include --dir");

  const newContent = "line one\nline two changed\nline three\nline four\nline five\n";
  const tabName = "✻ [Claude Code] hello.txt";
  const diffP = rpc("tools/call", {
    name: "openDiff",
    arguments: { old_file_path: file, new_file_path: file, new_file_contents: newContent, tab_name: tabName },
  });
  await sleep(400); // let the diff render + block on verdict
  const clean = cliOut.replace(/\x1b\[[0-9;]*m/g, "");
  if (!/changed/.test(clean) || !/line three/.test(clean)) fail("diff was not rendered to stdout");

  await rpc("tools/call", { name: "close_tab", arguments: { tab_name: tabName } }); // accept
  const res = await diffP;
  const texts = (res.result?.content ?? []).map((c) => c.text);
  if (texts[0] !== "FILE_SAVED") fail(`expected FILE_SAVED, got ${JSON.stringify(texts)}`);
  if (texts[1] !== newContent) fail(`accepted content mismatch: ${JSON.stringify(texts[1])}`);

  console.log("PASS: initialize + workspace folders + openDiff render + close_tab accept → FILE_SAVED");
  sock.close();
  child.kill();
  cleanup();
  process.exit(0);
});

setTimeout(() => fail("timeout"), 8000);
