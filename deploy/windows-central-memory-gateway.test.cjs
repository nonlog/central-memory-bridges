"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { createGateway } = require("./windows-central-memory-gateway.cjs");

test("loopback gateway adds API key and preserves request method/body", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-memory-gateway-"));
  const secretPath = path.join(dir, "key");
  const secret = "a".repeat(64);
  fs.writeFileSync(secretPath, secret);
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    seen.push({ path: req.url, method: req.method, key: req.headers["x-claude-mem-key"], body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gateway = createGateway({
    origin: "http://127.0.0.1:" + upstream.address().port,
    keyFile: secretPath,
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const base = "http://127.0.0.1:" + gateway.address().port;
  try {
    let response = await fetch(base + "/api/health");
    assert.equal(response.status, 200);
    response = await fetch(base + "/api/sessions/init", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentSessionId: "test-session" }),
    });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].key, secret);
    assert.equal(seen[1].method, "POST");
    assert.equal(JSON.parse(seen[1].body).contentSessionId, "test-session");
    response = await fetch(base + "/viewer");
    assert.equal(response.status, 404);
    response = await fetch(base + "//api/health");
    assert.equal(response.status, 404);
    fs.unlinkSync(secretPath);
    response = await fetch(base + "/api/health");
    assert.equal(response.status, 503);
  } finally {
    gateway.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an insecure nonloopback upstream", () => {
  assert.throws(
    () => createGateway({ origin: "http://example.org", keyFile: "nonexistent" }),
    /HTTPS/,
  );
});
