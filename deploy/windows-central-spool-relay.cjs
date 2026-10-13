#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { createGateway } = require('./windows-central-memory-gateway.cjs');

const DATA_DIR = path.resolve(process.env.CLAUDE_MEM_RELAY_DATA_DIR || __dirname);
const SPOOL_DIR = path.join(DATA_DIR, 'state', 'hook-spool');
const DEAD_DIR = path.join(DATA_DIR, 'state', 'central-spool-relay-dead-letter');
const LOG_FILE = path.join(DATA_DIR, 'central-spool-relay.log');
const LOCK_FILE = path.join(DATA_DIR, 'state', 'central-spool-relay.pid');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const KEY_FILE = path.resolve(process.env.CLAUDE_MEM_API_KEY_FILE || path.join(DATA_DIR, 'central-api-key'));
const PROXY_PORT = Number.parseInt(process.env.CLAUDE_MEM_RELAY_LISTEN_PORT || '37777', 10);
const SCAN_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;
const UNKNOWN_SESSION_MAX_RETRIES = 60;
const retryCounts = new Map();

function now() { return new Date().toISOString(); }

function log(level, message, extra) {
  const suffix = extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  const line = '[' + now() + '] [' + level + '] ' + message + suffix;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      try { fs.rmSync(LOG_FILE + '.1', { force: true }); } catch {}
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, line + os.EOL, 'utf8');
  } catch {}
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function readSettings() {
  try { return readJson(SETTINGS_FILE); } catch { return {}; }
}

function workerBaseUrl() {
  // The official Hooks use CLAUDE_MEM_WORKER_HOST=127.0.0.1 for this relay's
  // listener. Never derive the *remote* spool destination from that setting.
  return String(process.env.CLAUDE_MEM_RELAY_BASE_URL ||
    readSettings().CLAUDE_MEM_RELAY_BASE_URL ||
    'https://claude-mem.414222.xyz').trim().replace(/\/+$/, '');
}

function readApiKey() {
  let key;
  try { key = fs.readFileSync(KEY_FILE, 'utf8').trim(); }
  catch { throw new Error('central memory API key file unavailable'); }
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('central memory API key file invalid');
  return key;
}

function postJson(endpoint, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(workerBaseUrl());
    const mod = base.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = mod.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || undefined,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'claude-mem-central-spool-relay/2',
        'X-Claude-Mem-Key': readApiKey()
      },
      timeout: REQUEST_TIMEOUT_MS
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: res.statusCode || 0, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function pick(obj, ...keys) {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return undefined;
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function normalize(fileName, wrapper) {
  const payload = wrapper && typeof wrapper === 'object' && wrapper.payload && typeof wrapper.payload === 'object'
    ? wrapper.payload
    : wrapper;
  const kind = String(wrapper?.kind || (
    fileName.startsWith('observation-') ? 'observation' :
    fileName.startsWith('summarize-') ? 'summarize' :
    fileName.startsWith('session_end-') ? 'session_end' : ''
  ));

  if (!payload || typeof payload !== 'object') throw new Error('payload is not an object');

  const contentSessionId = pick(payload, 'contentSessionId', 'content_session_id');
  const platformSource = pick(payload, 'platformSource', 'platform_source');

  if (kind === 'observation') {
    const toolName = pick(payload, 'toolName', 'tool_name');
    if (!contentSessionId || !toolName) throw new Error('observation missing contentSessionId/toolName');
    return {
      kind,
      endpoint: '/api/sessions/observations',
      body: compact({
        contentSessionId,
        platformSource,
        tool_name: toolName,
        tool_input: pick(payload, 'toolInput', 'tool_input'),
        tool_response: pick(payload, 'toolResponse', 'tool_response'),
        cwd: payload.cwd,
        agentId: payload.agentId,
        agentType: payload.agentType,
        tool_use_id: pick(payload, 'toolUseId', 'tool_use_id'),
        or_generation_id: pick(payload, 'orGenerationId', 'or_generation_id'),
        or_session_id: pick(payload, 'orSessionId', 'or_session_id')
      })
    };
  }

  if (kind === 'summarize') {
    const lastAssistantMessage = pick(payload, 'lastAssistantMessage', 'last_assistant_message');
    if (!contentSessionId) throw new Error('summarize missing contentSessionId');
    if (typeof lastAssistantMessage !== 'string' || !lastAssistantMessage.trim()) {
      throw new Error('summarize missing lastAssistantMessage');
    }
    return {
      kind,
      endpoint: '/api/sessions/summarize',
      body: compact({
        contentSessionId,
        platformSource,
        last_assistant_message: lastAssistantMessage,
        agentId: payload.agentId,
        observedModel: payload.observedModel,
        observedBilling: payload.observedBilling,
        cwd: payload.cwd
      })
    };
  }

  if (kind === 'session_end') {
    if (!contentSessionId) throw new Error('session_end missing contentSessionId');
    return {
      kind,
      endpoint: '/api/sessions/session-end',
      body: compact({
        contentSessionId,
        platformSource,
        reason: payload.reason,
        cwd: payload.cwd
      })
    };
  }

  throw new Error('unsupported spool kind: ' + (kind || '(empty)'));
}

function classifyResponse(item, res) {
  const code = res.statusCode;
  if (code < 200 || code >= 300) {
    if (code === 400 || code === 422) return { action: 'dead', reason: 'HTTP ' + code + ': ' + res.text.slice(0, 300) };
    return { action: 'retry', reason: 'HTTP ' + code + ': ' + res.text.slice(0, 300) };
  }
  if (!res.json || typeof res.json !== 'object') {
    return { action: 'retry', reason: '2xx without JSON acknowledgement: ' + res.text.slice(0, 300) };
  }

  if (item.kind === 'observation' || item.kind === 'summarize') {
    if (res.json.status === 'queued') return { action: 'done' };
    if (res.json.status === 'skipped') {
      const reason = String(res.json.reason || 'unspecified');
      if (reason === 'unknown_session') return { action: 'retry-unknown', reason };
      if (/duplicate|dedup/i.test(reason)) return { action: 'done' };
      return { action: 'dead', reason: 'Worker skipped event: ' + reason };
    }
    return { action: 'retry', reason: 'unexpected acknowledgement: ' + res.text.slice(0, 300) };
  }

  if (item.kind === 'session_end') {
    if (typeof res.json.status === 'string') return { action: 'done' };
    return { action: 'retry', reason: 'unexpected session_end acknowledgement: ' + res.text.slice(0, 300) };
  }

  return { action: 'retry', reason: 'unclassified response' };
}

function moveDead(filePath, reason) {
  fs.mkdirSync(DEAD_DIR, { recursive: true });
  const base = path.basename(filePath);
  const dest = path.join(DEAD_DIR, base);
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  fs.renameSync(filePath, dest);
  fs.writeFileSync(dest + '.reason.txt', '[' + now() + '] ' + reason + os.EOL, 'utf8');
  retryCounts.delete(filePath);
  log('ERROR', 'Moved terminal spool event to dead-letter: ' + base, reason);
}

function listSpoolFiles() {
  if (!fs.existsSync(SPOOL_DIR)) return [];
  return fs.readdirSync(SPOOL_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const full = path.join(SPOOL_DIR, name);
      let order = Number.MAX_SAFE_INTEGER;
      try {
        const wrapper = readJson(full);
        const n = Number(wrapper?.enqueuedAtEpochMs);
        order = Number.isFinite(n) ? n : fs.statSync(full).mtimeMs;
      } catch {
        order = fs.statSync(full).mtimeMs;
      }
      return { name, full, order };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

async function processOne(file) {
  let wrapper;
  let item;
  try {
    wrapper = readJson(file.full);
    item = normalize(file.name, wrapper);
  } catch (err) {
    moveDead(file.full, 'invalid spool payload: ' + err.message);
    return 'continue';
  }

  let res;
  try {
    res = await postJson(item.endpoint, item.body);
  } catch (err) {
    log('WARN', 'Transient relay error; preserving ' + file.name, err.message);
    return 'stop';
  }

  const result = classifyResponse(item, res);
  if (result.action === 'done') {
    fs.rmSync(file.full, { force: false });
    retryCounts.delete(file.full);
    log('INFO', 'Forwarded ' + item.kind + ': ' + file.name, { status: res.statusCode });
    return 'continue';
  }

  if (result.action === 'retry-unknown') {
    const count = (retryCounts.get(file.full) || 0) + 1;
    retryCounts.set(file.full, count);
    if (count >= UNKNOWN_SESSION_MAX_RETRIES) {
      moveDead(file.full, 'unknown_session after ' + count + ' retries');
      return 'continue';
    }
    if (count === 1 || count % 10 === 0) {
      log('WARN', 'Session not known yet; preserving ' + file.name, { retry: count });
    }
    return 'stop';
  }

  if (result.action === 'dead') {
    moveDead(file.full, result.reason);
    return 'continue';
  }

  log('WARN', 'Worker did not acknowledge event; preserving ' + file.name, result.reason);
  return 'stop';
}

let sweeping = false;

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const file of listSpoolFiles()) {
      const result = await processOne(file);
      if (result === 'stop') break;
    }
  } catch (err) {
    log('ERROR', 'Relay sweep failed', err.stack || err.message);
  } finally {
    sweeping = false;
  }
}

function acquireSingleton() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let pid = 0;
      try { pid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10); } catch {}
      let alive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch {}
      }
      if (alive) {
        log('INFO', 'Relay already running as PID ' + pid + '; exiting');
        process.exit(0);
      }
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  throw new Error('failed to acquire singleton lock');
}

function releaseSingleton() {
  try {
    const owner = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (owner === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {}
}

// Run the synchronous official-hook gateway and the durable spool consumer
// inside the SAME Node process and the existing Spool Relay scheduled task.
function main() {
  if (!Number.isInteger(PROXY_PORT) || PROXY_PORT < 1 || PROXY_PORT > 65535) {
    throw new Error('invalid CLAUDE_MEM_RELAY_LISTEN_PORT');
  }
  const gateway = createGateway({ origin: workerBaseUrl(), keyFile: KEY_FILE });
  acquireSingleton();
  process.on('exit', releaseSingleton);
  fs.mkdirSync(SPOOL_DIR, { recursive: true });

  gateway.on('error', err => {
    log('ERROR', 'Local authenticated listener failed to bind', err.message);
    process.exitCode = 1;
    process.exit();
  });

  gateway.listen(PROXY_PORT, '127.0.0.1', () => {
    log('INFO', 'Central memory relay ready', {
      pid: process.pid,
      spoolDir: SPOOL_DIR,
      upstream: workerBaseUrl(),
      local: '127.0.0.1:' + PROXY_PORT
    });
    const timer = setInterval(() => { sweep(); }, SCAN_INTERVAL_MS);
    sweep();

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        clearInterval(timer);
        gateway.close();
        log('INFO', 'Central spool relay stopped by ' + signal);
        process.exit(0);
      });
    }
  });
}

if (require.main === module) main();

module.exports = { workerBaseUrl, readApiKey, postJson, normalize, classifyResponse, main };
