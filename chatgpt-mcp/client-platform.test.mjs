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
