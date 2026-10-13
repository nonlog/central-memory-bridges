#!/usr/bin/env node
"use strict";

// Loopback-only API gateway for upstream claude-mem hooks that cannot set a
// custom HTTP header. Never embed the API key in agent configuration or Git.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");

const DEFAULT_KEY_FILE = path.join(os.homedir(), ".claude-mem", "central-api-key");
const DROP_HEADERS = new Set([
  "connection", "host", "proxy-authorization", "proxy-connection",
  "te", "trailer", "upgrade", "keep-alive", "x-claude-mem-key",
]);

function createGateway({
  origin = process.env.CLAUDE_MEM_GATEWAY_UPSTREAM || "https://claude-mem.414222.xyz",
  keyFile = process.env.CLAUDE_MEM_API_KEY_FILE || DEFAULT_KEY_FILE,
} = {}) {
  const upstream = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname);
  if (upstream.protocol !== "https:" && !(upstream.protocol === "http:" && loopback)) {
    throw new Error("Gateway upstream must use HTTPS (or test-only HTTP loopback)");
  }
  if (upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) {
    throw new Error("Gateway upstream must be an origin URL without userinfo or path");
  }

  return http.createServer((req, res) => {
    const urlPath = req.url || "";
    // Deliberately do not expose a general-purpose proxy on this loopback port.
    if ((!urlPath.startsWith("/api/") && urlPath !== "/api") ||
        urlPath.startsWith("//") || urlPath.includes("\\")) {
      res.writeHead(404).end();
      return;
    }
    let key;
    try {
      key = fs.readFileSync(keyFile, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid or missing key");
    } catch {
      res.writeHead(503).end("Central memory API credential unavailable");
      return;
    }

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROP_HEADERS.has(name) && value !== undefined) headers[name] = value;
    }
    headers["x-claude-mem-key"] = key;
    const address = new URL(urlPath, upstream);
    const transport = upstream.protocol === "https:" ? https : http;
    const upstreamRequest = transport.request(address, {
      method: req.method,
      headers,
      timeout: 120000,
    }, upstreamResponse => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (!DROP_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value;
      }
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
    });

    upstreamRequest.on("timeout", () => upstreamRequest.destroy(new Error("upstream timeout")));
    upstreamRequest.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end("Central memory upstream unavailable");
    });
    req.on("aborted", () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  });
}

if (require.main === module) {
  const gateway = createGateway();
  const port = Number.parseInt(process.env.CLAUDE_MEM_GATEWAY_PORT || "37777", 10);
  gateway.listen(port, "127.0.0.1", () => {
    console.log("Central memory authenticated gateway on 127.0.0.1:" + port);
  });
}

module.exports = { createGateway };
