#!/usr/bin/env node
'use strict';
// CENTRAL_REMOTE_WORKER_GUARD_V2
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');

const upstream = path.join(__dirname, 'worker-service.central-upstream.cjs');
let settings = {};
const defaultDataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(os.homedir(), '.claude-mem');
try { settings = JSON.parse(fs.readFileSync(path.join(defaultDataDir, 'settings.json'), 'utf8')); } catch {}
const hostRaw = String(process.env.CLAUDE_MEM_WORKER_HOST || settings.CLAUDE_MEM_WORKER_HOST || '127.0.0.1').trim();
const port = Number.parseInt(process.env.CLAUDE_MEM_WORKER_PORT || settings.CLAUDE_MEM_WORKER_PORT || '37777', 10) || 37777;
const dataDir = process.env.CLAUDE_MEM_DATA_DIR || settings.CLAUDE_MEM_DATA_DIR || defaultDataDir;
const captureHooks = new Set(['observation', 'file-edit', 'summarize', 'session-end', 'subagent-stop']);
const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizedHost() {
  return hostRaw.replace(/^https?:\/\//i, '').replace(/\/$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function endpoint(pathname) {
  if (/^https?:\/\//i.test(hostRaw)) {
    const u = new URL(hostRaw);
    if (!u.port) u.port = String(port);
    u.pathname = pathname;
    u.search = '';
    return u;
  }
  const host = hostRaw.includes(':') && !hostRaw.startsWith('[') ? `[${hostRaw}]` : hostRaw;
  return new URL(`${port === 443 ? 'https' : 'http'}://${host}:${port}${pathname}`);
}

function getJson(pathname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const url = endpoint(pathname);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'claude-mem-central-remote-guard/1' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function hold(message, pluginVersion, workerVersion) {
  recordStatus('sync-required', message, pluginVersion, workerVersion);
  process.stderr.write(`claude-mem: ${message}; queued captures are retained. Run sync-claude-mem-central.ps1 -SyncLocal, then restart Claude/Codex on this computer.\n`);
  if (process.argv[2] === 'hook') {
    const result = {systemMessage: `Claude-mem: ${message}. Synchronize this computer and restart Claude/Codex; queued captures are retained.`};
    if (process.argv[4] === 'context') result.hookSpecificOutput = {hookEventName: 'SessionStart', additionalContext: ''};
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  process.exit(0);
}

function recordStatus(status, reason, pluginVersion, workerVersion) {
  try {
    const file = path.join(dataDir, 'state', 'central-client-status.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({schemaVersion: 1, computer: os.hostname(), status, reason, pluginVersion, workerVersion, checkedAt: new Date().toISOString()}));
    fs.renameSync(tmp, file);
  } catch (error) { process.stderr.write(`claude-mem: cannot save client status: ${error.message}\n`); }
}

function captureCompatible(client, worker) {
  if (client !== 'unknown' && client === worker) return true;
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(__dirname, 'central-client-compatibility.json'), 'utf8'));
    return policy.schemaVersion === 1 && policy.captureOnlyPairs.some(p => p.client === client && p.worker === worker && p.spoolProtocol === 1);
  } catch { return false; }
}

async function main() {
  if (!fs.existsSync(upstream)) {
    process.stderr.write(`claude-mem: guarded upstream entry missing: ${upstream}\n`);
    process.exit(1);
  }

  const remote = (process.env.CLAUDE_MEM_HOOK_SPOOL_TRANSPORT || settings.CLAUDE_MEM_HOOK_SPOOL_TRANSPORT) === 'http' || !localHosts.has(normalizedHost());
  const command = process.argv[2] || '';
  // Official write handlers persist before upload. Never gate that durable write
  // on remote availability; the separate upload-spool process is checked below.
  const capturing = command === 'hook' && captureHooks.has(process.argv[4]);
  if (remote && !capturing && (command === 'hook' || command === 'start' || command === 'upload-spool')) {
    let pluginVersion = 'unknown';
    try {
      pluginVersion = String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || 'unknown');
    } catch {}

    let health;
    try {
      health = await getJson('/api/health');
    } catch (error) {
      hold('remote Worker unavailable', pluginVersion, 'unknown');
    }

    const workerVersion = health && health.version ? String(health.version) : 'unknown';
    const uploadAllowed = command === 'upload-spool' && captureCompatible(pluginVersion, workerVersion);
    if (!uploadAllowed && (pluginVersion === 'unknown' || workerVersion === 'unknown' || pluginVersion !== workerVersion)) {
      hold(`client ${pluginVersion}, central Worker ${workerVersion}; local sync required`, pluginVersion, workerVersion);
    }
    if (health.status !== 'ok' || health.mcpReady !== true || health.dependencies?.degraded) hold('remote Worker is not healthy', pluginVersion, workerVersion);

    try {
      const ready = await getJson('/api/readiness');
      if (!ready || (ready.status !== 'ready' && ready.ready !== true)) {
        hold('remote Worker is not ready', pluginVersion, workerVersion);
      }
    } catch (error) {
      hold('remote Worker readiness check failed', pluginVersion, workerVersion);
    }
    recordStatus(pluginVersion === workerVersion ? 'ready' : 'capture-compatible', pluginVersion === workerVersion ? 'Versions aligned' : 'Capture protocol verified; synchronize this computer for context hooks', pluginVersion, workerVersion);
    if (command === 'start') return;
  }

  const childEnv = { ...process.env };
  if (remote) {
    childEnv.CLAUDE_MEM_WORKER_AUTOSTART = 'false';
    // Keep detached official uploaders behind this same compatibility check.
    childEnv.CLAUDE_MEM_WORKER_SCRIPT_PATH = __filename;
  }
  try {
    const pluginVersion = String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '').trim();
    const runtimeModuleRoots = [path.join(__dirname, '..', 'node_modules')];
    if (pluginVersion) {
      runtimeModuleRoots.push(path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', pluginVersion, 'node_modules'));
    }
    const existingRoots = runtimeModuleRoots.filter((root) => fs.existsSync(root));
    if (childEnv.NODE_PATH) existingRoots.push(childEnv.NODE_PATH);
    if (existingRoots.length > 0) childEnv.NODE_PATH = existingRoots.join(path.delimiter);
  } catch {}

  const result = cp.spawnSync(process.execPath, [upstream, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: childEnv,
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(`claude-mem: failed to launch guarded upstream entry: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status == null ? 0 : result.status);
}

main().catch((error) => {
  process.stderr.write(`claude-mem: remote-worker guard failed: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
