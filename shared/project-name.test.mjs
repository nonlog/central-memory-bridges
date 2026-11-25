import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProjectName, projectNameForCwd } from './project-name.mjs';

test('strips pi- and omp- prefixes while preserving real pi-* repos', () => {
  assert.equal(canonicalProjectName('pi-General'), 'General');
  assert.equal(canonicalProjectName('pi-Conduit'), 'Conduit');
  assert.equal(canonicalProjectName('pi-nova-search'), 'nova-search');
  assert.equal(canonicalProjectName('omp-AgentDock'), 'AgentDock');
  assert.equal(canonicalProjectName('pi-coding-agent'), 'pi-coding-agent');
  assert.equal(canonicalProjectName('pi-bar-cursor'), 'pi-bar-cursor');
});

test('normalizes Windows paths, flattened workspace paths, and worktrees', () => {
  assert.equal(canonicalProjectName('D:\\Workspace\\General'), 'General');
  assert.equal(canonicalProjectName('D:\\Workspace\\pixel-search'), 'pixel-search');
  assert.equal(canonicalProjectName('D:\\Downloads'), 'Downloads');
  assert.equal(canonicalProjectName('D-Workspace-general'), 'General');
  assert.equal(canonicalProjectName('C:\\Users\\www\\AppData\\Local\\OpenAI\\Codex\\bin\\a159911ff70742e9'), 'General');
  assert.equal(
    projectNameForCwd('D:\\Workspace\\worktrees\\pixel-search\\pi-worktree-deaa9301-bfb6-4328-b457-cbd92c64bdf3-s0-0'),
    'pixel-search',
  );
  assert.equal(
    projectNameForCwd('D:\\Workspace\\worktrees\\Conduit\\pi-worktree-5bda7fb3-0f2a-4e4c-b392-d9a2c57e0548-s0-0'),
    'Conduit',
  );
});

test('normalizes case aliases, sub-branches, and ephemeral slugs', () => {
  assert.equal(canonicalProjectName('general'), 'General');
  assert.equal(canonicalProjectName('conduit'), 'Conduit');
  assert.equal(canonicalProjectName('agentdock'), 'AgentDock');
  assert.equal(canonicalProjectName('pixel-aod-xposed/pixel-aod-coui-port'), 'pixel-aod-xposed');
  assert.equal(canonicalProjectName('codex-auto-title-kyxetyv8'), 'General');
  assert.equal(canonicalProjectName('a159911ff70742e9'), 'General');
  assert.equal(canonicalProjectName('https-github-com-foo-bar'), 'General');
  assert.equal(canonicalProjectName('pi-pi-worktree-1234'), 'General');
});

test('projectNameForCwd prefers gitProject when provided', () => {
  assert.equal(projectNameForCwd('/tmp/random-worktree', { gitProject: 'Conduit' }), 'Conduit');
  assert.equal(projectNameForCwd('/tmp/project'), 'project');
});
