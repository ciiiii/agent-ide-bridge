// Proves the core win: TWO clients connect to one window and BOTH stay
// connected (a single-client server would evict the first).
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const ideDir = join(homedir(), ".claude", "ide");
const lockName = readdirSync(ideDir).find((f) => f.endsWith(".lock"));
if (!lockName) throw new Error("no lockfile found");
const port = lockName.replace(".lock", "");
const { authToken, ideName } = JSON.parse(readFileSync(join(ideDir, lockName), "utf8"));
console.log(`lock: ${lockName} ideName=${ideName}`);

function connect(tag) {
  return new Promise((resolve, reject) => {
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
    ws.on("error", reject);
    ws.on("open", async () => {
      const init = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { roots: {}, sampling: {} },
        clientInfo: { name: `test-${tag}`, version: "0" },
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      const tools = await rpc("tools/list", {});
      resolve({ ws, tag, init, tools });
    });
  });
}

const a = await connect("A");
const b = await connect("B");
await new Promise((r) => setTimeout(r, 1500)); // give any eviction time to happen

const aOpen = a.ws.readyState === WebSocket.OPEN;
const bOpen = b.ws.readyState === WebSocket.OPEN;
console.log("A initialize:", JSON.stringify(a.init.result));
console.log("tools:", a.tools.result.tools.map((t) => t.name).join(", "));
console.log(`A open=${aOpen}  B open=${bOpen}`);
console.log(aOpen && bOpen ? "PASS ✅ both clients stay connected (multi-client)" : "FAIL ❌ a client was evicted");
process.exit(aOpen && bOpen ? 0 : 1);
