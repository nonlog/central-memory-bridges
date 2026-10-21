import * as z from 'zod/v4';
import { EXECUTOR_AGENT_IDENTITIES, resolveMemorySource } from './agent-identity.mjs';
import { workerSearchMajor, planMemorySearch, planDumbSearch, formatWorkerSearchResult, compactSmartSearchIndex } from '../shared/worker-search-compat.mjs';

// Worker-runtime memory API only. Server-only /v1 endpoints, filesystem search,
// host administration, and arbitrary Worker proxying are intentionally excluded.
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeOnly = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const projectName = z.string().min(1).max(96);
const positiveId = z.number().int().positive();
const recordKind = z.enum(['observation', 'summary', 'prompt']);
const recordItem = z.object({ type: recordKind, id: positiveId });
const workStateFieldValue = z.union([
  z.string(), z.number().finite().refine(n => !Number.isInteger(n) || Number.isSafeInteger(n)),
  z.boolean(), z.null(),
]);
const workStateFields = z.record(z.string().min(1), workStateFieldValue);

/** Match official Worker v13.41 WorkStateRoutes before invoking a write. */
export function validateWorkStateFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
    return 'fields must be a non-empty object';
  }
  if (Object.entries(fields).some(([key, value]) =>
    !key || !(value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))))
  )) return 'fields must map non-empty keys to strings, safe finite numbers, booleans or null';
  if (JSON.stringify(fields).length > 2_000) return 'fields must be at most 2000 characters as JSON';
  return null;
}

export function registerWorkerMemoryTools(server, { worker, platform, defaultProject, safeProject, redactSecrets, scopes }) {
  const granted = new Set(scopes);
  const agentIdentityInput = platform === 'executor' ? { agent_identity: z.enum(EXECUTOR_AGENT_IDENTITIES).optional().describe('Self-declared actual calling Agent; omit to use executor. This is not independently verified.') } : {};
  const requireScope = (scope) => {
    if (!granted.has(scope)) throw new Error(scope + ' OAuth scope required; reconnect the MCP connector and authorize this permission.');
  };
  const response = (result) => {
    const value = result && typeof result === 'object' ? result : { text: String(result ?? '') };
    const text = typeof result === 'string' ? result : JSON.stringify(value);
    return { content: [{ type: 'text', text }], structuredContent: Array.isArray(value) ? { items: value } : value };
  };
  const query = (params) => {
    const p = new URLSearchParams();
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== null && val !== '') p.set(key, String(val));
    }
    return p.toString();
  };
  const get = (endpoint, params = {}) => worker(endpoint + '?' + query(params), {}, 20_000);
  const post = (endpoint, body, timeout = 25_000) =>
    worker(endpoint, { method: 'POST', body: JSON.stringify(body) }, timeout);
  const virtualCwd = (project) => '/web-mcp/' + safeProject(project || defaultProject);
  const searchMajor = async () => workerSearchMajor(await worker('/api/version', {}, 5_000));
  const runSearch = async (plan) => {
    const raw = await worker(plan.route, plan.method === 'POST'
      ? { method: 'POST', body: JSON.stringify(plan.body) } : {}, 45_000);
    if (plan.step === 'smart-index') return compactSmartSearchIndex(raw, {
      query: new URL(plan.route, 'http://localhost').searchParams.get('query'),
      limit: Number(new URL(plan.route, 'http://localhost').searchParams.get('limit')) || undefined,
    });
    const mcp = formatWorkerSearchResult(raw);
    if (mcp) return { ...mcp, structuredContent: { ...raw, searchStep: plan.step } };
    return response(raw);
  };

  server.registerTool('mem_search', {
    title: 'Progressive memory search',
    description: 'Official 3-step progressive search; use mode=guided to inspect index, context, and selected records, or mode=auto for a bounded full search. Pass opaque continuation and selectedIds from previous results.',
    inputSchema: {
      mode: z.enum(['guided', 'auto']).optional(),
      query: z.string().min(1).max(500).optional(),
      project: projectName.optional(),
      limit: z.number().int().min(1).max(20).optional(),
      maxDetails: z.number().int().min(1).max(5).optional(),
      depthBefore: z.number().int().min(0).max(3).optional(),
      depthAfter: z.number().int().min(0).max(3).optional(),
      continuation: z.string().regex(/^ms_[A-Za-z0-9_-]{24}$/).optional(),
      selectedIds: z.array(z.union([z.string(), positiveId])).max(20).optional(),
    },
    annotations: readOnly,
  }, async (args) => {
    if (!args.query && !args.continuation) throw new Error('query or continuation required');
    return runSearch(planMemorySearch(await searchMajor(), args));
  });

  server.registerTool('dumb_search', {
    title: 'Fast shallow memory lookup',
    description: 'Optional one-call title-based search. Fast but shallow: use mem_search → memory_timeline → memory_get_observations for reliable recall. Worker 15 uses /api/dumb-search; Worker 14 falls back to legacy auto.',
    inputSchema: {
      query: z.string().min(1).max(500),
      project: projectName.optional(),
      limit: z.number().int().min(1).max(20).optional(),
      maxDetails: z.number().int().min(1).max(5).optional(),
      depthBefore: z.number().int().min(0).max(3).optional(),
      depthAfter: z.number().int().min(0).max(3).optional(),
    },
    annotations: readOnly,
  }, async (args) => runSearch(planDumbSearch(await searchMajor(), args)));

  server.registerTool('save_memory', {
    title: 'Save a durable memory directly',
    description: 'Official Worker-mode manual memory save. Executor callers may select agent_identity from the supported source list; omit when unsure. The selected Agent identity is self-declared, not verified.',
    inputSchema: {
      text: z.string().min(1).max(20_000),
      title: z.string().max(500).optional(),
      project: projectName.optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      ...agentIdentityInput,
    },
    annotations: writeOnly,
  }, async ({ text, title, project, metadata, agent_identity }) => {
    requireScope('memory:write');
    const source = resolveMemorySource(platform, agent_identity);
    const cleanMetadata = { ...(metadata || {}), platformSource: source, source, ...(platform === 'executor' ? { via: 'executor', identityAttribution: 'agent_selected' } : {}) };
    delete cleanMetadata.sourceFingerprint; // untrusted deduplication tokens must not hide an intended write
    return response(await post('/api/memory/save', {
      text: redactSecrets(text), title: title ? redactSecrets(title) : undefined,
      project: safeProject(project || defaultProject), metadata: cleanMetadata,
    }));
  });

  server.registerTool('memory_search_advanced', {
    title: 'Advanced filtered memory search',
    description: 'Search observations, sessions or prompts with source/project/type/date filters and pagination.',
    inputSchema: {
      query: z.string().max(500).optional(), project: projectName.optional(),
      platformSource: z.string().max(64).optional(), type: z.string().max(32).optional(),
      obs_type: z.string().max(100).optional(), dateStart: z.string().max(50).optional(),
      dateEnd: z.string().max(50).optional(), limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(), orderBy: z.enum(['date_desc', 'date_asc']).optional(),
    }, annotations: readOnly,
  }, async (args) => response(await get('/api/search', args)));

  server.registerTool('memory_timeline', {
    title: 'Memory timeline',
    description: 'Show nearby events around an exact observation ID or query anchor.',
    inputSchema: {
      anchor: positiveId.optional(), query: z.string().min(1).max(500).optional(),
      depth_before: z.number().int().min(0).max(20).optional(),
      depth_after: z.number().int().min(0).max(20).optional(),
      project: projectName.optional(),
    }, annotations: readOnly,
  }, async (args) => {
    if (!args.anchor && !args.query) throw new Error('anchor or query required');
    return response(await get('/api/timeline', args));
  });

  server.registerTool('memory_get_observations', {
    title: 'Fetch selected observations',
    description: 'Retrieve multiple exact observation IDs after searching.',
    inputSchema: {
      ids: z.array(positiveId).min(1).max(50), project: projectName.optional(),
      limit: z.number().int().min(1).max(50).optional(),
      orderBy: z.enum(['date_desc', 'date_asc']).optional(),
    }, annotations: readOnly,
  }, async (args) => response(await post('/api/observations/batch', args)));

  server.registerTool('memory_get_tool_uses', {
    title: 'Fetch raw tool records',
    description: 'Inspect original tool input/output only for known tool-use IDs (raw and potentially sensitive).',
    inputSchema: {
      ids: z.array(z.union([positiveId, z.string().min(1).max(128)])).min(1).max(30),
      limit: z.number().int().min(1).max(30).optional(),
      project: projectName.optional(), contentSessionId: z.string().max(160).optional(),
    }, annotations: readOnly,
  }, async (args) => response(await post('/api/tool-uses/batch', args)));

  server.registerTool('memory_list_records', {
    title: 'List memory records',
    description: 'Paginate observation, summary, prompt, or session records across projects/platforms.',
    inputSchema: {
      kind: z.enum(['observations','summaries','prompts','sessions']),
      project: projectName.optional(), platformSource: z.string().max(64).optional(),
      contentSessionId: z.string().max(160).optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(),
    }, annotations: readOnly,
  }, async ({ kind, ...filters }) => {
    if (kind === 'sessions') delete filters.contentSessionId;
    return response(await get('/api/' + kind, filters));
  });

  server.registerTool('memory_get_record', {
    title: 'Read exact memory record',
    description: 'Fetch a specific observation, prompt, or session summary by numeric ID before modifying it.',
    inputSchema: { type: recordKind, id: positiveId }, annotations: readOnly,
  }, async ({ type, id }) => response(await worker(
    '/api/' + (type === 'summary' ? 'session' : type) + '/' + id, {}, 10_000
  )));

  server.registerTool('memory_projects', {
    title: 'List memory projects',
    description: 'List all projects with their source labels; optional platform filter.',
    inputSchema: { platformSource: z.string().max(64).optional() }, annotations: readOnly,
  }, async (args) => response(await get('/api/projects', args)));

  server.registerTool('memory_stats', {
    title: 'Memory database statistics',
    description: 'Read Worker memory statistics without host administration.',
    inputSchema: {}, annotations: readOnly,
  }, async () => response(await worker('/api/stats', {}, 10_000)));

  server.registerTool('work_state_read', {
    title: 'Read persistent work state',
    description: 'Read tasks and tracked state for a stable Web MCP project. Pass the same project from any web client to share one list.',
    inputSchema: {
      project: projectName.optional(), list: z.string().max(100).optional(),
      includeClosed: z.boolean().optional(),
    }, annotations: readOnly,
  }, async ({ project, list, includeClosed }) => response(await get('/api/work-state', {
    cwd: virtualCwd(project), list, includeClosed,
  })));

  server.registerTool('work_state_write', {
    title: 'Update persistent work state',
    description: 'Append a task/status or arbitrary state fields to a project list. Virtual Web MCP cwd is a database key, not a filesystem path.',
    inputSchema: {
      project: projectName.optional(),
      list: z.string().min(1).max(200),
      fields: workStateFields,
    }, annotations: writeOnly,
  }, async ({ project, list, fields }) => {
    requireScope('memory:write');
    const invalid = validateWorkStateFields(fields);
    if (invalid) throw new Error(invalid);
    return response(await post('/api/work-state/entries', { cwd: virtualCwd(project), list, fields }));
  });

  server.registerTool('team_brief', {
    title: 'TeamBrain project brief',
    description: 'Get TeamBrain project context when TeamBrain is configured on this Worker.',
    inputSchema: { project: projectName.optional() }, annotations: readOnly,
  }, async ({ project }) => response(await get('/api/teambrain/brief', {
    project: safeProject(project || defaultProject),
  })));

  server.registerTool('team_search', {
    title: 'TeamBrain shared search',
    description: 'Search TeamBrain shared observations when the Worker TeamBrain feature is configured.',
    inputSchema: {
      query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional(),
    }, annotations: readOnly,
  }, async (args) => response(await post('/api/teambrain/search', args)));

  server.registerTool('session_start_context', {
    title: 'Full project session context',
    description: 'Render upstream Worker session-start memory context with project and platform filters.',
    inputSchema: {
      project: projectName.optional(), projects: z.array(projectName).min(1).max(8).optional(),
      platformSource: z.string().max(64).optional(), full: z.boolean().optional(),
      colors: z.boolean().optional(),
    }, annotations: readOnly,
  }, async ({ project, projects, ...args }) => response(await get('/api/context/inject', {
    ...args, projects: (projects || [project || defaultProject]).map(x => safeProject(x)).join(','),
  })));

  server.registerTool('memory_admin_permissions', {
    title: 'Check memory permissions',
    description: 'Show OAuth scopes currently granted to this MCP connection, including whether exact-ID deletion is authorized.',
    inputSchema: {}, annotations: readOnly,
  }, async () => response({
    platform, project: defaultProject, scopes: [...granted],
    ...(platform === 'executor' ? { agent_identity_options: [...EXECUTOR_AGENT_IDENTITIES], identity_attribution: 'agent_selected_not_verified' } : {}),
    can_delete: granted.has('memory:delete'),
    deletion_note: granted.has('memory:delete')
      ? 'Delete exact IDs only, after explicit user authorization.'
      : 'To use delete tools, reconnect and request OAuth scope memory:delete. Existing credentials are not silently escalated.',
  }));

  server.registerTool('claude_mem_forget', {
    title: 'Delete exact memory IDs',
    description: 'Permanently delete only enumerated observation, summary or prompt IDs using official sync-safe Worker DELETE routes. Requires separately authorized memory:delete OAuth scope. Never infer IDs or delete by fuzzy match; ask the user to confirm exact items.',
    inputSchema: {
      items: z.array(recordItem).min(1).max(50),
      confirm: z.literal(true).describe('Must be true only after user confirms the exact records.'),
    }, annotations: destructive,
  }, async ({ items }) => {
    requireScope('memory:delete');
    const unique = new Map();
    for (const item of items) unique.set(item.type + ':' + item.id, item);
    const deleted = [], failed = [];
    for (const {type,id} of unique.values()) {
      try {
        const result = await worker('/api/' + type + '/' + id, { method: 'DELETE' }, 12_000);
        deleted.push({ type, id, result });
      } catch (error) {
        failed.push({ type, id, error: String(error?.message || error).slice(0,400) });
      }
    }
    return response({ ok: failed.length === 0, deleted, failed });
  });

  server.registerTool('memory_delete_session', {
    title: 'Delete an exact memory session',
    description: 'Permanently delete one session and its contained records through the sync-aware Worker API. Requires memory:delete and confirmed exact source + session ID; not a fuzzy or project-wide delete.',
    inputSchema: {
      platformSource: z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),
      contentSessionId: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/),
      confirm: z.literal(true).describe('Explicit user confirmation required.'),
    }, annotations: destructive,
  }, async ({platformSource, contentSessionId}) => {
    requireScope('memory:delete');
    const res = await worker('/api/sessions/' + encodeURIComponent(platformSource) + '/' +
      encodeURIComponent(contentSessionId), { method:'DELETE' }, 15_000);
    return response(res);
  });
}
