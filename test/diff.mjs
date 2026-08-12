// End-to-end openDiff: open a diff, accept it via close_tab, verify the file is
// written and openDiff returns [FILE_SAVED, <content>].
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const ideDir = join(homedir(), ".claude", "ide");
const lockName = readdirSync(ideDir).find((f) => f.endsWith(".lock"));
const port = lockName.replace(".lock", "");
const { authToken } = JSON.parse(readFileSync(join(ideDir, lockName), "utf8"));

const file = "/tmp/bridge-diff-test.txt";
writeFileSync(file, "line one\nline two\n", "utf8");

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { "x-claude-code-ide-authorization": authToken },
});
let n = 0;
const pending = new Map();
const rpc = (method, params) =>
  new Promise((res) => {
    const id = ++n;
    pending.set(id, res);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "difftest", version: "0" },
});
ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

const tabName = "✻ [Claude Code] bridge-diff-test.txt";
const newContent = "line one\nline two — CHANGED BY BRIDGE TEST\nline three (added)\n";

// openDiff blocks until accept/reject; run it concurrently.
const diffP = rpc("tools/call", {
  name: "openDiff",
  arguments: { old_file_path: file, new_file_path: file, new_file_contents: newContent, tab_name: tabName },
});
await new Promise((r) => setTimeout(r, 1500)); // let the diff be visible in the window
const closeRes = await rpc("tools/call", { name: "close_tab", arguments: { tab_name: tabName } });
const diffRes = await diffP;

const content = diffRes.result?.content ?? [];
const marker = content[0]?.text;
const payload = content[1]?.text;
const onDisk = readFileSync(file, "utf8");
console.log("close_tab result:", JSON.stringify(closeRes.result));
console.log("openDiff marker:", marker, "| payload matches newContent:", payload === newContent);
console.log("file written correctly:", onDisk === newContent);
const pass = marker === "FILE_SAVED" && onDisk === newContent;
console.log(pass ? "PASS ✅ openDiff accept writes file + returns FILE_SAVED" : "FAIL ❌");
process.exit(pass ? 0 : 1);
