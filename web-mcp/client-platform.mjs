// Pure, backwards-compatible platform classification for the shared MCP endpoint.
// OAuth client IDs are authenticated and decoded by the server before calling here.
// A missing or unrecognized client stays ChatGPT to preserve legacy behavior.
const GEMINI_REDIRECT_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
  'oauth-redirect-test.googleusercontent.com',
  'gemini.google.com',
]);

const FACTORY_DROID_APP_CALLBACKS = new Set([
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
]);

function isFactoryDroidClient(registered) {
  if (registered?.client_name && registered.client_name !== 'Factory Droid') return false;
  if (registered?.client_uri && registered.client_uri !== 'https://app.factory.ai') return false;
  const redirects = registered.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0) return false;
  let hasFactoryCallback = false;
  return redirects.every((uri) => {
    if (FACTORY_DROID_APP_CALLBACKS.has(uri)) {
      hasFactoryCallback = true;
      return true;
    }
    try {
      const u = new URL(uri);
      const port = u.port ? Number(u.port) : 0;
      return u.protocol === 'http:' && u.hostname === '127.0.0.1' &&
        u.pathname === '/callback' && (port === 0 || (port >= 54621 && port <= 54720));
    } catch {
      return false;
    }
  }) && hasFactoryCallback;
}

export function resolveClientPlatform(clientId, decodeRegisteredClient) {
  if (!clientId || typeof decodeRegisteredClient !== 'function') return 'chatgpt';
  // Factory publishes this stable Client ID Metadata Document for Droid CLI.
  if (clientId === 'https://api.factory.ai/mcp/oauth-client') return 'droid';
  try {
    const registered = decodeRegisteredClient(clientId);
    const redirects = registered?.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0) return 'chatgpt';
    if (isFactoryDroidClient(registered)) return 'droid';
    const isGemini = redirects.every((uri) => {
      const u = new URL(uri);
      return u.protocol === 'https:' && GEMINI_REDIRECT_HOSTS.has(u.hostname.toLowerCase());
    });
    if (isGemini) return 'gemini';
    const rules = [
      { platform: 'claude-web', hosts: ['claude.ai', 'claude.com'], callback: '/api/mcp/auth_callback' },
      { platform: 'grok-web', hosts: ['grok.com', 'www.grok.com'], callback: '/connectors-oauth-exchange-code' },
      { platform: 'muse-web', hosts: ['agent.meta.ai'], callback: '/api/hatch/oauth/callback' },
      { platform: 'executor', hosts: ['executor.414222.xyz'], callback: '/api/oauth/callback' },
    ];
    for (const rule of rules) {
      if (redirects.every((uri) => {
        const u = new URL(uri);
        return u.protocol === 'https:' && rule.hosts.includes(u.hostname.toLowerCase()) &&
          u.pathname.replace(/\/$/, '') === rule.callback;
      })) return rule.platform;
    }
    return 'chatgpt';
  } catch {
    return 'chatgpt';
  }
}
