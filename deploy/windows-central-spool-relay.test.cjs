"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

async function getPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function poll(check, maxMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error("Timed out waiting for the consolidated relay");
}

test("one relay process serves synchronous hooks and forwards spool with the same API key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmem-unified-relay-"));
  const secret = "a".repeat(64);
  const keyFile = path.join(dir, "central-api-key");
  fs.writeFileSync(keyFile, secret);
  const spoolDir = path.join(dir, "state", "hook-spool");
  fs.mkdirSync(spoolDir, { recursive: true });
  const file = path.join(spoolDir, "observation-test.json");
  fs.writeFileSync(file, JSON.stringify({
    kind: "observation",
    payload: {
      contentSessionId: "unified-relay-test",
      platformSource: "codex",
      toolName: "test_tool",
      toolInput: { hello: "world" },
      toolResponse: "test"
    }
  }));

  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push({
      path: req.url, method: req.method, body,
      key: req.headers["x-claude-mem-key"],
    });
    res.setHeader("content-type", "application/json");
    res.end(req.method === "GET" ? JSON.stringify({ status: "ok" }) :
      JSON.stringify({ status: "queued" }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");

  const listenPort = await getPort();
  const child = spawn(process.execPath, [path.join(__dirname, "windows-central-spool-relay.cjs")], {
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_MEM_API_KEY_FILE: keyFile,
      CLAUDE_MEM_RELAY_DATA_DIR: dir,
      CLAUDE_MEM_RELAY_BASE_URL: "http://127.0.0.1:" + upstream.address().port,
      CLAUDE_MEM_RELAY_LISTEN_PORT: String(listenPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", b => { diagnostics += b.toString(); });
  child.stderr.on("data", b => { diagnostics += b.toString(); });
  const base = "http://127.0.0.1:" + listenPort;
  try {
    await poll(async () => {
      if (child.exitCode !== null) throw new Error("relay exited");
      return (await fetch(base + "/api/health")).ok;
    });
    await poll(() => !fs.existsSync(file));
    assert.ok(requests.some(r => r.path === "/api/health" && r.key === secret));
    const spool = requests.find(r => r.path === "/api/sessions/observations");
    assert.ok(spool, "Expected spool POST direct to authenticated upstream");
    assert.equal(spool.method, "POST");
    assert.equal(spool.key, secret);
    assert.equal(JSON.parse(spool.body).contentSessionId, "unified-relay-test");
    const hiddenPath = await fetch(base + "/viewer");
    assert.equal(hiddenPath.status, 404);
    assert.ok(!diagnostics.includes(secret), "API key must never be logged");
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 4000))]);
    }
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
