// Shared scaffolding for the CLI e2e tests: isolated dirs, lockfile discovery, a
// WebSocket JSON-RPC client (with the roots/list responder), node-pty loading, and
// ANSI stripping. Each test supplies only its spawn (pty vs child_process) + scenario.
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const cli = join(repoRoot, "dist/cli.js");
export const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Load node-pty, restoring the prebuilt spawn-helper's exec bit. Returns null if absent. */
export function loadPty() {
  const require = createRequire(import.meta.url);
  try {
    const d = dirname(require.resolve("node-pty/package.json"));
    const helper = join(d, `prebuilds/${process.platform}-${process.arch}/spawn-helper`);
    if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  } catch {}
  try {
    return require("node-pty");
  } catch {
    return null;
  }
}

/** Isolated CLAUDE_CONFIG_DIR + workspace dir, with a cleanup(). */
export function tmpDirs() {
  const cfg = mkdtempSync(join(tmpdir(), "aib-cfg-"));
  const wsDir = mkdtempSync(join(tmpdir(), "aib-ws-"));
  const cleanup = () => {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
  };
  return { cfg, wsDir, cleanup };
}

/** Poll the isolated ide dir for the CLI's lockfile; returns { port, authToken, ... }. */
export async function waitForLock(cfg) {
  const ideDir = join(cfg, "ide");
  for (let i = 0; i < 50; i++) {
    try {
      const f = readdirSync(ideDir).find((x) => x.endsWith(".lock"));
      if (f) return { port: f.replace(".lock", ""), ...JSON.parse(readFileSync(join(ideDir, f), "utf8")) };
    } catch {}
    await sleep(100);
  }
  throw new Error(`no lockfile written in ${ideDir}`);
}

/** Connect over WS, auto-answer roots/list, resolve { sock, rpc, notify } once open. */
export function connect({ port, authToken, wsDir }) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-claude-code-ide-authorization": authToken },
  });
  const pending = new Map();
  let seq = 0;
  sock.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "roots/list") {
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { roots: [{ uri: `file://${wsDir}` }] } }));
    }
  });
  const rpc = (method, params) =>
    new Promise((res) => {
      const id = `c${++seq}`;
      pending.set(id, res);
      sock.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  const notify = (method, params) => sock.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  return new Promise((resolve, reject) => {
    sock.on("open", () => resolve({ sock, rpc, notify }));
    sock.on("error", reject);
  });
}

/** initialize + initialized notification. */
export async function handshake(conn, name) {
  await conn.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name, version: "1" } });
  conn.notify("notifications/initialized");
}

/** Convenience: content[].text of a tools/call response. */
export const texts = (res) => (res.result?.content ?? []).map((c) => c.text);
