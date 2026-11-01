import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClientPlatform } from './client-platform.mjs';

function classified(uris, metadata = {}) {
  return resolveClientPlatform('authenticated-client', () => ({ redirect_uris: uris, ...metadata }));
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

test('Factory Droid is identified by its registered client metadata and callback set', () => {
  const redirects = [
    'http://127.0.0.1/callback',
    'http://127.0.0.1:54621/callback',
    'http://127.0.0.1:54622/callback',
    'http://127.0.0.1:54623/callback',
    'https://dev.app.factory.ai/mcp/oauth/callback',
    'https://staging.app.factory.ai/mcp/oauth/callback',
    'https://preprod.app.factory.ai/mcp/oauth/callback',
    'https://app.factory.ai/mcp/oauth/callback',
    'https://dev.app.eu.factory.ai/mcp/oauth/callback',
    'https://staging.app.eu.factory.ai/mcp/oauth/callback',
    'https://preprod.app.eu.factory.ai/mcp/oauth/callback',
    'https://app.eu.factory.ai/mcp/oauth/callback',
    'http://localhost:3002/mcp/oauth/callback',
    'http://127.0.0.1:3002/mcp/oauth/callback',
  ];
  const metadata = { client_name: 'Factory Droid', client_uri: 'https://app.factory.ai' };
  assert.equal(classified(redirects, metadata), 'droid');
  assert.equal(classified(redirects), 'droid'); // Existing DCR registrations predate signed client metadata.
  assert.equal(resolveClientPlatform('https://api.factory.ai/mcp/oauth-client', () => { throw new Error('CIMD does not use DCR'); }), 'droid');
  assert.equal(classified(redirects, { ...metadata, client_name: 'Other MCP client' }), 'chatgpt');
  assert.equal(classified([...redirects, 'https://evil.factory.ai/mcp/oauth/callback'], metadata), 'chatgpt');
  assert.equal(classified(['http://127.0.0.1:54621/callback'], metadata), 'chatgpt');
});
