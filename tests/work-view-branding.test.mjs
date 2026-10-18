import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const patcher = path.resolve(here, '..', 'deploy', 'apply-claude-mem-viewer-branding.mjs');
const upstream = `// Upstream agent icon mapping must never be deleted.
export function agentIcon(agent) {
  const name = { codex: 'chatgpt', claude: 'claude', 'gemini-cli': 'gemini', 'hermes-cli': 'hermes' }[agent.platformSource];
  return name ? \`/assets/agents/\${name}.svg\` : null;
}
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mem-work-view-test-'));
  const ui = path.join(root, 'plugin', 'ui', 'work-view');
  fs.mkdirSync(ui, { recursive: true });
  fs.writeFileSync(path.join(ui, 'view-model.js'), upstream);
  return { root, model: path.join(ui, 'view-model.js') };
}
function invoke(root, ...args) {
  return spawnSync(process.execPath, [patcher, '--root', root, ...args], {
    env: { ...process.env, CLAUDE_MEM_BRANDING_NO_ICON_DOWNLOAD: '1' },
    encoding: 'utf8',
  });
}
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

test('preserves upstream mappings, adds extras, and is idempotent', async t => {
  const {root, model} = fixture();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.equal(invoke(root, '--check').status, 1, 'new installs must fail --check');
  let r = invoke(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(invoke(root, '--check').status, 0);
  const first = fs.readFileSync(model, 'utf8');
  assert.match(first, /central-memory-bridges: extra-agent-icons:start/);
  assert.match(first, /const name = \{ codex: 'chatgpt', claude: 'claude'/);
  const lib = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(first));
  for (const [platform, expected] of Object.entries({
    codex: 'chatgpt', claude: 'claude', 'gemini-cli': 'gemini', 'hermes-cli': 'hermes',
    hermes: 'hermes', chatgpt: 'chatgpt', 'chatgpt-web': 'chatgpt',
    gemini: 'gemini', 'gemini-web': 'gemini', 'claude-web': 'claude',
    pi: 'bridge-pi', 'pi-agent': 'bridge-pi',
    'grok-web': 'bridge-grok-web', 'muse-web': 'bridge-muse-web',
    executor: 'bridge-executor', openclaw: 'bridge-openclaw', omp: 'bridge-omp',
  })) {
    assert.equal(lib.agentIcon({ platformSource: platform }), `/assets/agents/${expected}.svg`, platform);
  }
  assert.equal(lib.agentIcon({ platformSource: 'unrecognized' }), null);
  for (const icon of ['pi','executor','grok-web','muse-web','openclaw','omp']) {
    assert.match(fs.readFileSync(path.join(path.dirname(model), 'assets/agents/bridge-' + icon + '.svg'), 'utf8'), /<svg/);
  }
  const before = sha(fs.readFileSync(model));
  r = invoke(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sha(fs.readFileSync(model)), before);
  assert.equal((fs.readFileSync(model, 'utf8').match(/extra-agent-icons:start/g) || []).length, 1);
});

test('respects newly supported native upstream identities', async t => {
  const {root, model} = fixture();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(model, upstream.replace("'hermes-cli': 'hermes'", "'hermes-cli': 'hermes', 'pi-agent': 'pi'"));
  const r = invoke(root);
  assert.equal(r.status, 0, r.stderr);
  const modified = fs.readFileSync(model, 'utf8');
  const lib = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(modified));
  assert.equal(lib.agentIcon({ platformSource:'pi-agent' }), '/assets/agents/pi.svg');
  assert.equal(lib.agentIcon({ platformSource:'pi' }), '/assets/agents/bridge-pi.svg');
});

test('detects upstream function signature changes without overwriting source', t => {
  const {root, model} = fixture();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(model, 'export const agentIcon = source => null;');
  const before = fs.readFileSync(model, 'utf8');
  const result = invoke(root);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(model, 'utf8'), before);
  assert.notEqual(invoke(root, '--check').status, 0);
});

test('viewer CSS and work-view icons coexist and --check is read-only', t => {
  const {root, model} = fixture();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const viewer = path.join(root, 'plugin/ui/viewer.html');
  fs.writeFileSync(viewer, '<html><style>\n    .card-title {color: black;}\n</style></html>');
  assert.equal(invoke(root).status, 0);
  const v = fs.readFileSync(viewer, 'utf8');
  assert.match(v, /platform-source-icons:start/);
  assert.equal(invoke(root, '--check').status, 0);
  const before = [sha(fs.readFileSync(viewer)),sha(fs.readFileSync(model))];
  assert.equal(invoke(root,'--check').status, 0);
  assert.deepEqual([sha(fs.readFileSync(viewer)),sha(fs.readFileSync(model))],before);
});
