import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClientPlatform } from './client-platform.mjs';

function classified(uris) {
  return resolveClientPlatform('authenticated-client', () => ({ redirect_uris: uris }));
}

test('existing ChatGPT client keeps its source', () => {
  assert.equal(classified(['https://chatgpt.com/connector_platform_oauth_redirect']), 'chatgpt');
});

test('existing Gemini web OAuth client is recognized without reconnection', () => {
  assert.equal(classified(['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc']), 'gemini');
  assert.equal(classified(['https://gemini.google.com/oauth-redirect']), 'gemini');
});

test('malformed, unknown, or mixed OAuth clients cannot impersonate Gemini', () => {
  assert.equal(classified(['https://oauth-redirect.googleusercontent.com.evil.test/r/callback']), 'chatgpt');
  assert.equal(classified(['https://oauth-redirect.googleusercontent.com/r/callback', 'https://other.example/callback']), 'chatgpt');
  assert.equal(classified(['http://oauth-redirect.googleusercontent.com/r/callback']), 'chatgpt');
  assert.equal(classified(['not a url']), 'chatgpt');
  assert.equal(classified([]), 'chatgpt');
  assert.equal(resolveClientPlatform('', () => ({})), 'chatgpt');
  assert.equal(resolveClientPlatform('invalid', () => { throw new Error('invalid token'); }), 'chatgpt');
});

test('Claude Web and Grok Web OAuth callbacks are distinct from code clients', () => {
  assert.equal(classified(['https://claude.ai/api/mcp/auth_callback']), 'claude-web');
  assert.equal(classified(['https://claude.com/api/mcp/auth_callback']), 'claude-web');
  assert.equal(classified(['https://grok.com/connectors-oauth-exchange-code/']), 'grok-web');
  assert.equal(classified(['https://www.grok.com/connectors-oauth-exchange-code']), 'grok-web');
  assert.equal(classified(['https://claude.ai.evil.invalid/api/mcp/auth_callback']), 'chatgpt');
  assert.equal(classified(['https://grok.com/other']), 'chatgpt');
  assert.equal(classified(['https://claude.ai/api/mcp/auth_callback', 'https://other.invalid/']), 'chatgpt');
});


test('Executor and Muse Web use their actual registered redirect hosts', () => {
  assert.equal(classified(['https://executor.414222.xyz/api/oauth/callback']), 'executor');
  assert.equal(classified(['https://agent.meta.ai/api/hatch/oauth/callback']), 'muse-web');
  assert.equal(classified(['https://executor.414222.xyz.evil.invalid/api/oauth/callback']), 'chatgpt');
  assert.equal(classified(['https://agent.meta.ai.evil.invalid/api/hatch/oauth/callback']), 'chatgpt');
  assert.equal(classified(['https://agent.meta.ai/other']), 'chatgpt');
  assert.equal(classified(['https://executor.414222.xyz/api/oauth/callback','https://untrusted.invalid/cb']), 'chatgpt');
  assert.equal(classified(['http://executor.414222.xyz/api/oauth/callback']), 'chatgpt');
});
