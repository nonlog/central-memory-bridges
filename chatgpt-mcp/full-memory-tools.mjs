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

export function selectHindsightBanks(banks = [], query = '', defaultBank = 'agent-central', maxBanks = 4) {
  const chosen = [defaultBank];
  const tokens = [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) || [])
    .flatMap((w) => w.split(/[_\-.]+/).filter(Boolean).concat(w)))];
  if (!tokens.length) return chosen;
  const scored = [];
  for (const raw of banks) {
    const id = typeof raw === 'string' ? raw : (raw?.bank_id || raw?.id || '');
    if (!id || chosen.includes(id)) continue;
    const short = id.replace(/^coding-agent::/i, '').toLowerCase();
    const hits = tokens.filter((t) => short === t || (t.length > 2 && short.includes(t)) || (short.length > 2 && t.includes(short))).length;
    if (hits > 0) scored.push({ id, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id));
  for (const item of scored) {
    if (chosen.length >= maxBanks) break;
    chosen.push(item.id);
  }
  return chosen;
}

export function registerWorkerMemoryTools(server, { worker, hindsight, hindsightDefaultBank = 'agent-central', platform, defaultProject, safeProject, redactSecrets, scopes }) {
  const granted = new Set(scopes);
  const callHindsight = async (path, options = {}, timeout = 20_000) => {
    if (typeof hindsight !== 'function') throw new Error('Hindsight integration is not configured on this bridge');
    return await hindsight(path, options, timeout);
  };
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
    description: 'Search central memory. Worker 15+: mem_search({query}) returns a compact index; inspect matches with memory_timeline and memory_get_observations. Worker 14 only: mode=guided supports opaque continuation and selectedIds. mode=auto runs a shallow one-call search.',
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
    const saved = await post('/api/memory/save', {
      text: redactSecrets(text), title: title ? redactSecrets(title) : undefined,
      project: safeProject(project || defaultProject), metadata: cleanMetadata,
    });
    if (typeof hindsight === 'function') {
      try {
        const cleanTitle = title ? redactSecrets(title) : '';
        const cleanText = redactSecrets(text);
        const docId = Number.isSafeInteger(saved?.id) && saved.id > 0
          ? 'cm-observation-' + String(saved.id).padStart(8, '0')
          : undefined;
        await callHindsight('/v1/default/banks/' + encodeURIComponent(hindsightDefaultBank) + '/memories', {
          method: 'POST',
          body: JSON.stringify({
            async: true,
            items: [{
              content: cleanTitle ? `# ${cleanTitle}\n\n${cleanText}` : cleanText,
              context: `Saved via ${source} (${platform})`,
              ...(docId ? { document_id: docId } : {}),
              metadata: { platformSource: source, source, project: safeProject(project || defaultProject), ...(platform === 'executor' ? { via: 'executor', identityAttribution: 'agent_selected' } : {}) },
            }],
          }),
        }, 10_000);
      } catch {}
    }
    return response(saved);
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
  }, async (args) => response(await get('/api/search', { ...args, format: 'json' })));

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

  server.registerTool('hindsight_recall', {
    title: 'Recall Hindsight memory & knowledge pages',
    description: 'Search Hindsight long-term memory and curated Knowledge Pages across agent-central and per-repository coding-agent::<repo> banks, read a full Knowledge Page by page_id, or list all banks.',
    inputSchema: {
      query: z.string().min(1).max(1000).optional(),
      bank: z.string().min(1).max(128).optional().describe('Hindsight bank ID (e.g. agent-central or coding-agent::<repo>). Omit to search agent-central and matching project banks.'),
      budget: z.enum(['low', 'mid', 'high']).optional(),
      max_tokens: z.number().int().min(100).max(4096).optional(),
      include_knowledge_pages: z.boolean().optional().describe('Also search curated Knowledge Pages in the selected bank(s). Default true.'),
      page_id: z.string().min(1).max(128).optional().describe('Read one Knowledge Page in full by page_id.'),
      list_banks: z.boolean().optional().describe('List available Hindsight banks and fact counts.'),
    },
    annotations: readOnly,
  }, async ({ query: q, bank, budget = 'low', max_tokens = 1200, include_knowledge_pages = true, page_id, list_banks }) => {
    if (list_banks) {
      const raw = await callHindsight('/v1/default/banks', {}, 10_000);
      const list = (Array.isArray(raw) ? raw : raw?.banks || []).map((b) =>
        typeof b === 'string' ? { bank_id: b } : { bank_id: b.bank_id || b.id, name: b.name || '', fact_count: b.fact_count ?? 0 }
      );
      return response({ banks: list });
    }
    if (page_id) {
      const targetBank = bank || hindsightDefaultBank;
      const page = await callHindsight(
        '/v1/default/banks/' + encodeURIComponent(targetBank) + '/knowledge-base/pages/' + encodeURIComponent(page_id),
        {}, 10_000,
      );
      return response({ bank: targetBank, page });
    }
    if (!q || !q.trim()) throw new Error('query, page_id, or list_banks=true is required');
    const cleanQuery = redactSecrets(q.trim());
    let targetBanks = bank ? [bank] : [hindsightDefaultBank];
    if (!bank) {
      try {
        const rawBanks = await callHindsight('/v1/default/banks', {}, 6_000);
        const allBanks = Array.isArray(rawBanks) ? rawBanks : (rawBanks?.banks || []);
        targetBanks = selectHindsightBanks(allBanks, cleanQuery, hindsightDefaultBank, 4);
      } catch {}
    }
    const memories = [], knowledge_pages = [];
    await Promise.all(targetBanks.map(async (b) => {
      const encoded = encodeURIComponent(b);
      const jobs = [
        callHindsight('/v1/default/banks/' + encoded + '/memories/recall', {
          method: 'POST',
          body: JSON.stringify({ query: cleanQuery, budget, max_tokens }),
        }, 18_000).then((res) => {
          for (const item of (Array.isArray(res?.results) ? res.results.slice(0, 12) : [])) {
            if (item?.text) memories.push({ bank: b, id: item.id || '', document_id: item.document_id || '', text: redactSecrets(item.text), mentioned_at: item.mentioned_at || item.occurred_start || '' });
          }
        }).catch((err) => { if (bank) throw err; }),
      ];
      if (include_knowledge_pages) {
        jobs.push(
          callHindsight('/v1/default/banks/' + encoded + '/knowledge-base/search?' + query({ q: cleanQuery, limit: 5 }), {}, 10_000)
            .then((res) => {
              const items = Array.isArray(res) ? res : (res?.results || res?.pages || res?.items || []);
              for (const page of items.slice(0, 5)) {
                knowledge_pages.push({ bank: b, ...page });
              }
            }).catch(() => {})
        );
      }
      await Promise.all(jobs);
    }));
    return response({ banks: targetBanks, memories, knowledge_pages });
  });

  server.registerTool('hindsight_reflect', {
    title: 'Deep Hindsight reasoning (reflect)',
    description: 'Run agentic synthesis over Hindsight memory (agent-central or a coding-agent::<repo> bank) to answer WHY questions, architectural decisions, or root-cause history.',
    inputSchema: {
      query: z.string().min(1).max(2000),
      bank: z.string().min(1).max(128).optional().describe('Target bank ID (default: agent-central, or pass coding-agent::<repo>).'),
      context: z.string().max(2000).optional(),
      budget: z.enum(['low', 'mid', 'high']).optional(),
      max_tokens: z.number().int().min(256).max(4096).optional(),
    },
    annotations: readOnly,
  }, async ({ query: q, bank, context, budget = 'low', max_tokens = 2048 }) => {
    const targetBank = bank || hindsightDefaultBank;
    const result = await callHindsight('/v1/default/banks/' + encodeURIComponent(targetBank) + '/reflect', {
      method: 'POST',
      body: JSON.stringify({
        query: redactSecrets(q),
        budget,
        max_tokens,
        ...(context ? { context: redactSecrets(context) } : {}),
      }),
    }, 60_000);
    const payload = typeof result === 'object' && result !== null ? { bank: targetBank, ...result } : { bank: targetBank, text: String(result ?? '') };
    return response(payload);
  });

  server.registerTool('hindsight_retain', {
    title: 'Retain durable memory in Hindsight',
    description: 'Store a durable fact, decision, or reference document in Hindsight (defaults to agent-central) with secret redaction. Executor callers may select agent_identity from the supported source list.',
    inputSchema: {
      content: z.string().min(1).max(20_000),
      title: z.string().max(500).optional(),
      context: z.string().max(1000).optional(),
      bank: z.string().min(1).max(128).optional().describe('Target bank ID (default: agent-central).'),
      document_id: z.string().max(160).optional(),
      tags: z.array(z.string().min(1).max(64)).max(10).optional(),
      ...agentIdentityInput,
    },
    annotations: writeOnly,
  }, async ({ content, title, context, bank, document_id, tags, agent_identity }) => {
    requireScope('memory:write');
    const targetBank = bank || hindsightDefaultBank;
    const source = resolveMemorySource(platform, agent_identity);
    const cleanTitle = title ? redactSecrets(title) : '';
    const cleanContent = cleanTitle ? `# ${cleanTitle}\n\n${redactSecrets(content)}` : redactSecrets(content);
    const metadata = {
      platformSource: source,
      source,
      project: safeProject(defaultProject),
      ...(platform === 'executor' ? { via: 'executor', identityAttribution: 'agent_selected' } : {}),
    };
    const result = await callHindsight('/v1/default/banks/' + encodeURIComponent(targetBank) + '/memories', {
      method: 'POST',
      body: JSON.stringify({
        async: true,
        items: [{
          content: cleanContent,
          context: context ? redactSecrets(context) : `Retained via ${source} (${platform})`,
          ...(document_id ? { document_id: redactSecrets(document_id) } : {}),
          metadata,
          ...(tags?.length ? { tags } : {}),
        }],
      }),
    }, 20_000);
    return response({ ok: true, bank: targetBank, source, result });
  });
}
