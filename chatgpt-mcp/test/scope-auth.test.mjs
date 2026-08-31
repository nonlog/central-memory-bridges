import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const oauthSecret = 'scope-regression-test-secret-0123456789abcdef';
let workerServer;
let bridgeProcess;
let workerPort;
let bridgePort;
let lastSessionId = '';
let workerWriteCount = 0;

function seal(prefix, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', oauthSecret).update(`${prefix}.${body}`).digest('base64url');
  return `${prefix}.${body}.${sig}`;
}

function accessToken(scope) {
  const now = Math.floor(Date.now() / 1000);
  return seal('at', {
    kind: 'access',
    sub: 'scope-test',
    client_id: 'scope-test-client',
    scope,
    iat: now,
    exp: now + 300,
  });
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function callTool(token, name, args) {
  const response = await fetch(`http://127.0.0.1:${bridgePort}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function waitForBridge() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge did not become ready');
}

before(async () => {
  workerServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/context/recent') {
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'recent-ok' }] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/observations') {
      res.end(JSON.stringify({ items: lastSessionId ? [{ id: 777, memory_session_id: lastSessionId }] : [] }));
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/')) {
      const body = await readJson(req);
      if (url.pathname === '/api/sessions/init') lastSessionId = String(body.contentSessionId || '');
      workerWriteCount += 1;
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    workerServer.once('error', reject);
    workerServer.listen(0, '127.0.0.1', () => {
      workerPort = workerServer.address().port;
      resolve();
    });
  });

  bridgePort = await freePort();
  bridgeProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: packageDir,
    env: {
      ...process.env,
      PORT: String(bridgePort),
      HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER: `http://127.0.0.1:${workerPort}`,
      EXTERNAL_BASE: `http://127.0.0.1:${bridgePort}`,
      OAUTH_SECRET: oauthSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForBridge();
});

after(async () => {
  bridgeProcess?.kill('SIGTERM');
  await new Promise((resolve) => workerServer?.close(() => resolve()));
});

test('memory:read token can call read tools without Worker writes', async () => {
  workerWriteCount = 0;
  const response = await callTool(accessToken('memory:read'), 'memory_recent', { project: 'scope-test', limit: 1 });
  assert.equal(response.result?.isError, undefined);
  assert.match(response.result?.content?.[0]?.text || '', /recent-ok/);
  assert.equal(workerWriteCount, 0);
});

test('memory:read token cannot call memory_capture or memory_remember', async () => {
  workerWriteCount = 0;
  const token = accessToken('memory:read');

  for (const [name, args] of [
    ['memory_capture', { user_message: 'scope test', assistant_message: 'should not persist', project: 'scope-test' }],
    ['memory_remember', { content: 'should not persist', project: 'scope-test' }],
  ]) {
    const response = await callTool(token, name, args);
    assert.equal(response.result?.isError, true, `${name} should be rejected`);
    assert.match(response.result?.content?.[0]?.text || '', /memory:write scope required/);
  }

  assert.equal(workerWriteCount, 0);
});

test('memory:read memory:write token can call write tools', async () => {
  workerWriteCount = 0;
  lastSessionId = '';
  const response = await callTool(
    accessToken('memory:read memory:write'),
    'memory_remember',
    { content: 'authorized scope regression marker', project: 'scope-test' },
  );

  assert.equal(response.result?.isError, undefined);
  assert.equal(response.result?.structuredContent?.ok, true);
  assert.equal(workerWriteCount, 3);
});
