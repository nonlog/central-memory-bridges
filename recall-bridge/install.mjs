#!/usr/bin/env node
/** Idempotent Windows install of the user-owned bridge, not an upstream patch. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = process.argv[2] || 'status';
if (!['install','status','remove'].includes(command)) {
  console.error('Usage: node recall-bridge/install.mjs install|status|remove');
  process.exit(2);
}
const home = homedir();
const base = join(home, '.central-memory-bridges');
const runtime = join(base, 'runtime');
const paths = {
  codex: join(home,'.codex','hooks.json'),
  claude: join(home,'.claude','settings.json'),
  config: join(base,'recall.json'),
};
const marker = 'central-memory-bridges/unified-recall';
const script = join(runtime,'hook.mjs');
const hookFor = agent => ({
  matcher: '*',
  hooks: [{ type: 'command', command: 'node "' + script + '" ' + agent, timeout: 12, statusMessage: 'Searching shared project memories' }],
});
function installedHook(item, agent) {
  const cmd=String(item?.hooks?.[0]?.command || '').toLowerCase().replaceAll('/','\\');
  return cmd.includes('central-memory-bridges\\runtime\\hook.mjs') && cmd.endsWith(' ' + agent);
}

function read(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { encoding:'utf8', mode: 0o600 });
}
function updateHooks(file, agent, remove = false) {
  const obj = read(file);
  const hooks = obj.hooks ??= {};
  const list = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  const kept = list.filter(x => !installedHook(x,agent));
  if (!remove) kept.push(hookFor(agent));
  hooks.UserPromptSubmit = kept;
  save(file,obj);
}
if (command === 'status') {
  const conf = read(paths.config);
  for (const [key,file] of Object.entries(paths)) {
    if (key === 'config') continue;
    const hooks = read(file).hooks?.UserPromptSubmit || [];
    console.log(key, hooks.some(x => installedHook(x, key === 'claude' ? 'claude-code' : key)) ? 'installed' : 'missing');
  }
  console.log('mode',conf.mode || 'not-configured','runtime',existsSync(script) ? 'installed' : 'missing');
  process.exit(0);
}
const backup = join(base,'backups',new Date().toISOString().replace(/[:.]/g,'-'));
for (const [name,file] of Object.entries(paths)) {
  if (!existsSync(file)) continue;
  const dest = join(backup,name + '.json');
  mkdirSync(dirname(dest), {recursive:true});
  copyFileSync(file,dest);
}
if (command === 'install') {
  mkdirSync(runtime,{recursive:true});
  for (const file of ['core.mjs','hook.mjs','telemetry.mjs','hindsight-mcp-bootstrap.cjs']) {
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)),file),join(runtime,file));
  }
  const conf = read(paths.config);
  save(paths.config, { mode:'shadow',...conf });
  updateHooks(paths.codex,'codex');
  updateHooks(paths.claude,'claude-code');
} else {
  updateHooks(paths.codex,'codex',true);
  updateHooks(paths.claude,'claude-code',true);
  const conf=read(paths.config);
  save(paths.config,{...conf,mode:'off'});
}
console.log(command,'complete','backup',backup);
