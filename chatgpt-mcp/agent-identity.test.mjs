import assert from 'node:assert/strict';
import test from 'node:test';
import { EXECUTOR_AGENT_IDENTITIES, resolveMemorySource } from './agent-identity.mjs';

test('Executor defaults to an honest general source', () => {
  assert.equal(resolveMemorySource('executor'), 'executor');
  assert.equal(resolveMemorySource('executor', 'executor'), 'executor');
});
test('Executor can select each supported documented source', () => {
  for (const identity of EXECUTOR_AGENT_IDENTITIES) assert.equal(resolveMemorySource('executor', identity), identity);
});
test('Unknown agent identities are rejected, not silently turned into arbitrary platform strings', () => {
  assert.throws(() => resolveMemorySource('executor', 'evil-platform'), /Unsupported agent_identity/);
  assert.throws(() => resolveMemorySource('executor', null), /Unsupported agent_identity/);
});
test('Other OAuth clients cannot override their platform through self-declared source fields', () => {
  for (const platform of ['chatgpt','gemini','claude-web','grok-web','muse-web']) {
    assert.equal(resolveMemorySource(platform,'codex'),platform);
  }
});
