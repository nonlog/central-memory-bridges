// Pure, backwards-compatible platform classification for the shared MCP endpoint.
// OAuth client IDs are authenticated and decoded by the server before calling here.
// A missing or unrecognized client stays ChatGPT to preserve legacy behavior.
const GEMINI_REDIRECT_HOSTS = new Set([
  'oauth-redirect.googleusercontent.com',
  'gemini.google.com',
]);

export function resolveClientPlatform(clientId, decodeRegisteredClient) {
  if (!clientId || typeof decodeRegisteredClient !== 'function') return 'chatgpt';
  try {
    const registered = decodeRegisteredClient(clientId);
    const redirects = registered?.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0) return 'chatgpt';
    const isGemini = redirects.every((uri) => {
      const u = new URL(uri);
      return u.protocol === 'https:' && GEMINI_REDIRECT_HOSTS.has(u.hostname.toLowerCase());
    });
    if (isGemini) return 'gemini';
    const rules = [
      { platform: 'claude-web', hosts: ['claude.ai', 'claude.com'], callback: '/api/mcp/auth_callback' },
      { platform: 'grok-web', hosts: ['grok.com', 'www.grok.com'], callback: '/connectors-oauth-exchange-code' },
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
