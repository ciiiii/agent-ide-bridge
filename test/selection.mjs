// Listens for selection_changed notifications from the bridge. On connect the
// bridge should push the current selection (if a file is active); then it should
// push again each time you move the cursor / open a file in code-server.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const ideDir = join(homedir(), ".claude", "ide");
const lockName = readdirSync(ideDir).find((f) => f.endsWith(".lock"));
const port = lockName.replace(".lock", "");
const { authToken } = JSON.parse(readFileSync(join(ideDir, lockName), "utf8"));
console.log(`listening on bridge port ${port} for 20s — click into files / select text in code-server…`);

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { "x-claude-code-ide-authorization": authToken },
});
let n = 0;
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.method === "selection_changed") {
    n++;
    const p = m.params || {};
    const sel = p.selection || {};
    console.log(
      `selection_changed #${n}: ${p.filePath || "(none)"}` +
        (sel.isEmpty === false ? `  L${sel.start?.line}-L${sel.end?.line}  "${(p.text || "").slice(0, 40)}"` : "  (cursor)")
    );
  } else if (m.method) {
    console.log(`notify: ${m.method}`);
  }
});
ws.on("open", () => {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sel-test", version: "0" } } }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
});
setTimeout(() => {
  console.log(n ? `\nPASS ✅ received ${n} selection_changed notification(s)` : "\n(no selection_changed — is a file focused in code-server?)");
  process.exit(0);
}, 20000);
