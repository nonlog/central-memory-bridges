import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import express from 'express';
import * as z from 'zod/v4';

const PORT = Number(process.env.PORT || 18790);
const HOST = process.env.HOST || '127.0.0.1';
const WORKER = (process.env.CLAUDE_MEM_WORKER || 'http://127.0.0.1:37777').replace(/\/$/, '');
const EXTERNAL_BASE = (process.env.EXTERNAL_BASE || 'https://claude-mem.414222.xyz/chatgpt-mcp').replace(/\/$/, '');
const RESOURCE_URL = `${EXTERNAL_BASE}/mcp`;
const OAUTH_SECRET = process.env.OAUTH_SECRET || '';
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 60 * 60 * 24 * 30;
const DEFAULT_SCOPES = ['memory:read', 'memory:write', 'offline_access'];
const ALLOWED_SCOPES = new Set(DEFAULT_SCOPES);
const DEFAULT_PROJECT = 'chatgpt-web';
const DEFAULT_CONTEXT_PROJECTS = ['chatgpt', DEFAULT_PROJECT];

if (OAUTH_SECRET.length < 32) {
  throw new Error('OAUTH_SECRET must be at least 32 characters');
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function unb64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}
function mac(data) {
  return crypto.createHmac('sha256', OAUTH_SECRET).update(data).digest('base64url');
}
function seal(prefix, payload) {
  const body = b64url(JSON.stringify(payload));
  return `${prefix}.${body}.${mac(`${prefix}.${body}`)}`;
}
function open(prefix, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== prefix) throw new Error('invalid token');
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(mac(signed));
  const got = Buffer.from(parts[2]);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) throw new Error('invalid signature');
  const value = JSON.parse(unb64url(parts[1]));
  if (value.exp && Date.now() / 1000 > value.exp) throw new Error('expired');
  return value;
}
function now() {
  return Math.floor(Date.now() / 1000);
}
function sha256b64url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}
function normalizeScopes(scope) {
  const requested = String(scope || DEFAULT_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  const scopes = [...new Set(requested.filter((s) => ALLOWED_SCOPES.has(s)))];
  if (!scopes.includes('memory:read')) scopes.unshift('memory:read');
  return scopes;
}
function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
function oauthError(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}
function external(path) {
  return `${EXTERNAL_BASE}${path}`;
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*[^\s,;]{8,}/gi,
];
function redactSecrets(value) {
  let text = String(value || '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED_SECRET]');
  return text;
}
function safeProject(project, fallback = DEFAULT_PROJECT) {
  const cleaned = String(project || fallback).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || fallback).slice(0, 96);
}
function extractWorkerText(raw) {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw?.content)) return raw.content.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n');
  return JSON.stringify(raw);
}
async function worker(path, options = {}, timeoutMs = 45000) {
  const response = await fetch(`${WORKER}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`claude-mem ${response.status}: ${text.slice(0, 500)}`);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}
async function searchObservations(query, limit = 8) {
  const q = new URLSearchParams({ query, limit: String(Math.min(Math.max(limit, 1), 20)) });
  const raw = await worker(`/api/search/observations?${q.toString()}`, {}, 45000);
  const text = extractWorkerText(raw);
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*#(\d+)\s*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|/);
    if (m) ids.push({ id: Number(m[1]), title: m[2].trim() });
  }
  const items = [];
  for (const hit of ids.slice(0, limit)) {
    try {
      const obs = await worker(`/api/observation/${hit.id}`, {}, 8000);
      items.push(obs);
    } catch {
      items.push({ id: hit.id, title: hit.title });
    }
  }
  return { text, items };
}
function observationText(obs) {
  const parts = [];
  if (obs.title) parts.push(`# ${obs.title}`);
  if (obs.subtitle) parts.push(obs.subtitle);
  if (obs.narrative) parts.push(obs.narrative);
  if (obs.facts) {
    try {
      const facts = typeof obs.facts === 'string' ? JSON.parse(obs.facts) : obs.facts;
      if (Array.isArray(facts) && facts.length) parts.push(`Facts:\n${facts.map((f) => `- ${f}`).join('\n')}`);
    } catch {
      parts.push(`Facts:\n${obs.facts}`);
    }
  }
  return parts.filter(Boolean).join('\n\n');
}
function observationUrl(id) {
  return `${EXTERNAL_BASE}/observation/${id}`;
}
async function waitForObservation(project, sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const q = new URLSearchParams({ project: safeProject(project), limit: '50' });
      const raw = await worker(`/api/observations?${q.toString()}`, {}, 8000);
      const items = Array.isArray(raw?.items) ? raw.items : [];
      const matches = items.filter((item) => String(item?.memory_session_id || '').includes(sessionId));
      if (matches.length) return matches.map((item) => item.id).filter((id) => Number.isFinite(Number(id)));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return [];
}
async function writeTurn({ userMessage, assistantMessage, project = DEFAULT_PROJECT, sessionId }) {
  const p = safeProject(project);
  const sid = `chatgpt-${safeProject(sessionId || crypto.randomUUID(), crypto.randomUUID())}`;
  const user = redactSecrets(userMessage).slice(0, 16000);
  const assistant = redactSecrets(assistantMessage).slice(0, 24000);
  if (!user.trim() && !assistant.trim()) throw new Error('nothing to store');
  await worker('/api/sessions/init', {
    method: 'POST', body: JSON.stringify({ contentSessionId: sid, project: p, prompt: user || '[memory capture]' }),
  }, 8000);
  if (assistant.trim()) {
    await worker('/api/sessions/observations', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: sid,
        tool_name: 'assistant_message',
        tool_input: { source: 'chatgpt-web' },
        tool_response: assistant.slice(0, 1000),
        cwd: 'chatgpt-web',
      }),
    }, 15000);
  }
  await worker('/api/sessions/summarize', {
    method: 'POST', body: JSON.stringify({ contentSessionId: sid, last_assistant_message: assistant.slice(0, 4000) }),
  }, 45000);
  const observationIds = assistant.trim() ? await waitForObservation(p, sid) : [];
  return {
    ok: true,
    project: p,
    session_id: sid,
    commit_status: assistant.trim() ? (observationIds.length ? 'committed' : 'queued') : 'summary_queued',
    observation_ids: observationIds,
    secrets_redacted: user !== userMessage || assistant !== assistantMessage,
  };
}

function makeServer() {
  const server = new McpServer(
    { name: 'central-claude-mem', version: '1.0.0' },
    {
      instructions: [
        'This app is the shared long-term memory for ChatGPT, Claude Code, Codex, OpenClaw, Hermes, and Pi.',
        'For substantive turns where prior decisions, preferences, deployments, or ongoing work may matter, call memory_context or memory_search before answering.',
        'For each substantive turn worth retaining, before sending the final response call memory_capture once with the current user message and the final response you intend to send, then send that same response to the user.',
        'Use memory_remember for explicit durable facts or decisions. Do not store passwords, API keys, tokens, private keys, or other secrets.',
        'Treat recalled content as past records; when records conflict, prefer the most recent verified information.',
      ].join(' '),
    },
  );

  server.registerTool('search', {
    title: 'Search central memory',
    description: 'Search the shared central claude-mem pool. Use for Company Knowledge and whenever prior work, decisions, preferences, deployment history, or cross-client context may matter.',
    inputSchema: { query: z.string().min(1).max(1000) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query }) => {
    const { items } = await searchObservations(query, 10);
    const results = items.map((obs) => ({ id: `obs:${obs.id}`, title: obs.title || `Observation ${obs.id}`, url: observationUrl(obs.id) }));
    return { content: [{ type: 'text', text: JSON.stringify({ results }) }], structuredContent: { results } };
  });

  server.registerTool('fetch', {
    title: 'Fetch central memory item',
    description: 'Fetch one central claude-mem observation returned by search.',
    inputSchema: { id: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const m = String(id).match(/(\d+)/);
    if (!m) throw new Error('id must contain an observation number');
    const obs = await worker(`/api/observation/${m[1]}`, {}, 8000);
    const result = {
      id: `obs:${obs.id}`,
      title: obs.title || `Observation ${obs.id}`,
      text: observationText(obs),
      url: observationUrl(obs.id),
      metadata: { project: obs.project || '', type: obs.type || '', created_at: obs.created_at || '' },
    };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('memory_search', {
    title: 'Semantic memory search',
    description: 'Search across Claude Code, Codex, OpenClaw, Hermes, Pi, ChatGPT, and other projects in the shared central memory pool. Prefer this when exact prior context could improve the answer.',
    inputSchema: { query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, limit = 8 }) => {
    const { text } = await searchObservations(query, limit);
    return { content: [{ type: 'text', text }] };
  });

  server.registerTool('memory_recent', {
    title: 'Recent project memory',
    description: 'Read recent central memory for a known project such as chatgpt-web, pi-Download, hermes-default, openclaw-main, or another project name.',
    inputSchema: { project: z.string().min(1).max(96), limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ project, limit = 5 }) => {
    const q = new URLSearchParams({ project: safeProject(project), limit: String(limit) });
    const raw = await worker(`/api/context/recent?${q.toString()}`, {}, 8000);
    return { content: [{ type: 'text', text: extractWorkerText(raw) }] };
  });

  server.registerTool('memory_context', {
    title: 'Recall ChatGPT context',
    description: 'Retrieve the central memory context for ChatGPT. In a Workspace Agent, call this near the start of every substantive user turn before answering, so relevant cross-session memory can be used consistently.',
    inputSchema: { projects: z.array(z.string().min(1).max(96)).min(1).max(8).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ projects }) => {
    const selected = (projects?.length ? projects : DEFAULT_CONTEXT_PROJECTS).map((p) => safeProject(p));
    const q = new URLSearchParams({ projects: selected.join(',') });
    const raw = await worker(`/api/context/inject?${q.toString()}`, {}, 10000);
    return { content: [{ type: 'text', text: extractWorkerText(raw).slice(0, 16000) }] };
  });

  server.registerTool('memory_capture', {
    title: 'Capture completed ChatGPT turn',
    description: 'Write a completed user/assistant turn to the shared central claude-mem pool. In a Workspace Agent, call this once at the end of every substantive response, after composing the answer, so ChatGPT contributes durable cross-session memory like Claude Code/Codex. Common secrets are redacted before storage.',
    inputSchema: {
      user_message: z.string().max(16000),
      assistant_message: z.string().max(24000),
      project: z.string().max(96).optional(),
      session_id: z.string().max(128).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ user_message, assistant_message, project = DEFAULT_PROJECT, session_id }) => {
    const result = await writeTurn({ userMessage: user_message, assistantMessage: assistant_message, project, sessionId: session_id });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  server.registerTool('memory_remember', {
    title: 'Remember durable information',
    description: 'Explicitly store a durable fact, decision, preference, or work result in central claude-mem. Do not send passwords, API keys, tokens, private keys, or other secrets; common secret formats are redacted defensively.',
    inputSchema: { content: z.string().min(1).max(20000), project: z.string().max(96).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ content, project = DEFAULT_PROJECT }) => {
    const result = await writeTurn({ userMessage: 'Remember this durable information for future sessions.', assistantMessage: content, project });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });

  return server;
}

function issueTokens(clientId, scope, subject = 'www') {
  const iat = now();
  const scopes = normalizeScopes(scope);
  const access = seal('at', { kind: 'access', sub: subject, client_id: clientId, scope: scopes.join(' '), iat, exp: iat + ACCESS_TTL });
  const refresh = seal('rt', { kind: 'refresh', sub: subject, client_id: clientId, scope: scopes.join(' '), iat, exp: iat + REFRESH_TTL });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(' ') };
}

const app = createMcpExpressApp({ host: HOST, allowedHosts: ['127.0.0.1', 'localhost', 'claude-mem.414222.xyz'] });
app.use(express.urlencoded({ extended: false }));

const authMetadata = {
  issuer: EXTERNAL_BASE,
  authorization_endpoint: external('/oauth/authorize'),
  token_endpoint: external('/oauth/token'),
  registration_endpoint: external('/oauth/register'),
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: DEFAULT_SCOPES,
};
const resourceMetadata = {
  resource: RESOURCE_URL,
  authorization_servers: [EXTERNAL_BASE],
  scopes_supported: DEFAULT_SCOPES,
  bearer_methods_supported: ['header'],
};

for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/chatgpt-mcp', '/chatgpt-mcp/.well-known/oauth-authorization-server']) {
  app.get(path, (_req, res) => res.json(authMetadata));
}
for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/chatgpt-mcp/mcp', '/chatgpt-mcp/.well-known/oauth-protected-resource']) {
  app.get(path, (_req, res) => res.json(resourceMetadata));
}

app.post(['/oauth/register', '/chatgpt-mcp/oauth/register'], (req, res) => {
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter(validRedirect) : [];
  if (!redirectUris.length) return oauthError(res, 400, 'invalid_redirect_uri', 'At least one HTTPS or loopback redirect URI is required');
  const iat = now();
  const payload = { redirect_uris: redirectUris, iat, exp: iat + REFRESH_TTL, token_endpoint_auth_method: 'none' };
  const clientId = seal('cl', payload);
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: iat,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

app.get(['/oauth/authorize', '/chatgpt-mcp/oauth/authorize'], (req, res) => {
  try {
    const authUser = String(req.get('x-auth-user') || '').trim();
    if (!authUser) return oauthError(res, 401, 'access_denied', 'Owner authentication is required');
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, resource } = req.query;
    if (response_type !== 'code') return oauthError(res, 400, 'unsupported_response_type', 'Only authorization code is supported');
    if (!client_id || !redirect_uri || !code_challenge || code_challenge_method !== 'S256') return oauthError(res, 400, 'invalid_request', 'PKCE S256, client_id, and redirect_uri are required');
    const client = open('cl', client_id);
    if (!client.redirect_uris.includes(String(redirect_uri))) return oauthError(res, 400, 'invalid_request', 'redirect_uri is not registered');
    if (resource && resource !== RESOURCE_URL) return oauthError(res, 400, 'invalid_target', 'resource does not match this MCP server');
    const scopes = normalizeScopes(scope);
    const iat = now();
    const code = seal('ac', {
      kind: 'code', sub: authUser, client_id: String(client_id), redirect_uri: String(redirect_uri),
      code_challenge: String(code_challenge), scope: scopes.join(' '), iat, exp: iat + 300,
    });
    const target = new URL(String(redirect_uri));
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', String(state));
    res.redirect(302, target.toString());
  } catch (error) {
    oauthError(res, 400, 'invalid_request', error.message);
  }
});

app.post(['/oauth/token', '/chatgpt-mcp/oauth/token'], (req, res) => {
  try {
    const grant = req.body?.grant_type;
    if (grant === 'authorization_code') {
      const code = open('ac', req.body?.code);
      if (code.client_id !== req.body?.client_id || code.redirect_uri !== req.body?.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'client or redirect mismatch');
      const verifier = String(req.body?.code_verifier || '');
      if (!verifier || sha256b64url(verifier) !== code.code_challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      return res.json(issueTokens(code.client_id, code.scope, code.sub));
    }
    if (grant === 'refresh_token') {
      const refresh = open('rt', req.body?.refresh_token);
      if (req.body?.client_id && refresh.client_id !== req.body.client_id) return oauthError(res, 400, 'invalid_grant', 'client mismatch');
      return res.json(issueTokens(refresh.client_id, refresh.scope, refresh.sub));
    }
    return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  } catch (error) {
    return oauthError(res, 400, 'invalid_grant', error.message);
  }
});

function requireBearer(req, res, next) {
  try {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) throw new Error('missing bearer token');
    const token = open('at', match[1]);
    if (token.kind !== 'access') throw new Error('wrong token type');
    const scopes = new Set(String(token.scope || '').split(/\s+/));
    if (!scopes.has('memory:read')) throw new Error('memory:read scope required');
    req.centralMemoryAuth = token;
    next();
  } catch (error) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${EXTERNAL_BASE}/.well-known/oauth-protected-resource", scope="memory:read memory:write"`);
    res.status(401).json({ error: 'invalid_token', error_description: error.message });
  }
}

app.get('/health', async (_req, res) => {
  try {
    const health = await worker('/api/health', {}, 3000);
    res.json({ status: 'ok', bridge: 'central-claude-mem', worker: health?.status || 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'degraded', error: error.message });
  }
});

app.get('/observation/:id', requireBearer, async (req, res) => {
  try {
    const obs = await worker(`/api/observation/${encodeURIComponent(req.params.id)}`, {}, 8000);
    res.json({ id: obs.id, project: obs.project, title: obs.title, subtitle: obs.subtitle, text: observationText(obs), created_at: obs.created_at });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/mcp', requireBearer, async (req, res) => {
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body, {
      token: String(req.get('authorization')).replace(/^Bearer\s+/i, ''),
      clientId: req.centralMemoryAuth.client_id,
      scopes: String(req.centralMemoryAuth.scope).split(/\s+/),
    });
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  } finally {
    res.on('close', () => { transport.close(); server.close(); });
  }
});
app.get('/mcp', requireBearer, (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
app.delete('/mcp', requireBearer, (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

app.listen(PORT, HOST, () => console.log(`central-claude-mem MCP listening on http://${HOST}:${PORT}`));
