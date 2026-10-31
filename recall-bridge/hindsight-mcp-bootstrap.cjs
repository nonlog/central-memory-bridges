'use strict';

/**
 * Secret-free launcher for the unmodified official Hindsight MCP.
 *
 * Windows desktop apps may have been started before a User-scope environment
 * variable was created. Their subprocesses inherit the stale environment.
 * Reload HKCU\Environment at each MCP start without printing the token.
 */
const { execFileSync, spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

function parseUserEnvironmentValue(output, key) {
  if (!/^[A-Z][A-Z0-9_]*$/i.test(key)) return '';
  for (const line of String(output || '').split(/\r?\n/)) {
    const columns = line.trim().match(/^([A-Z][A-Z0-9_]*)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
    if (columns && columns[1].toUpperCase() === key.toUpperCase()) {
      return columns[2].trim();
    }
  }
  return '';
}

function readUserEnvironmentValue(key, exec = execFileSync) {
  try {
    const executable = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'reg.exe')
      : 'reg.exe';
    const raw = exec(executable, ['query', 'HKCU\\Environment', '/v', key], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseUserEnvironmentValue(raw, key);
  } catch {
    return '';
  }
}

function ensureToken(env = process.env, {
  platform = process.platform,
  reader = readUserEnvironmentValue,
} = {}) {
  const userToken = platform === 'win32'
    ? reader('HINDSIGHT_API_TOKEN') || reader('HINDSIGHT_API_KEY')
    : '';
  if (userToken) env.HINDSIGHT_API_TOKEN = userToken;
  if (!env.HINDSIGHT_API_TOKEN && env.HINDSIGHT_API_KEY) {
    env.HINDSIGHT_API_TOKEN = env.HINDSIGHT_API_KEY;
  }
  return Boolean(env.HINDSIGHT_API_TOKEN);
}

/**
 * Desktop agents may inherit stale proxy settings just like stale credentials.
 * Refresh user-scoped networking variables at every local MCP launch.
 * Prefer HKCU entries, but preserve process-only values if unset.
 */
function ensureProxyEnvironment(env = process.env, {
  platform = process.platform,
  reader = readUserEnvironmentValue,
} = {}) {
  if (platform !== 'win32') return env;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
    const value = reader(key);
    if (value) env[key] = value;
  }
  if ((env.HTTPS_PROXY || env.HTTP_PROXY) && !env.NODE_USE_ENV_PROXY) {
    env.NODE_USE_ENV_PROXY = '1';
  }
  return env;
}

function launch() {
  if (!ensureToken()) {
    console.error('hindsight: HINDSIGHT_API_TOKEN is unavailable in the Windows user environment.');
    process.exitCode = 1;
    return;
  }
  ensureProxyEnvironment();
  const official = join(homedir(), '.hindsight', 'coding-agents', 'dist', 'mcp-server.js');
  if (!existsSync(official)) {
    console.error('hindsight: the official MCP runtime is missing; reinstall the official plugin.');
    process.exitCode = 1;
    return;
  }
  // The official entrypoint explicitly requires process.argv[1] to equal its
  // own filename. Importing it would skip main() and leave MCP disconnected.
  const child = spawn(process.execPath, [official], {
    env: process.env, cwd: process.cwd(), stdio: 'inherit', windowsHide: true,
  });
  child.on('error', () => {
    console.error('hindsight: could not launch the official MCP runtime.');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal && process.platform !== 'win32') {
      process.kill(process.pid, signal);
    } else {
      process.exitCode = Number.isInteger(code) ? code : 1;
    }
  });
  for (const signal of ['SIGINT','SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

module.exports = { parseUserEnvironmentValue, readUserEnvironmentValue, ensureToken, ensureProxyEnvironment };
if (require.main === module) launch();
