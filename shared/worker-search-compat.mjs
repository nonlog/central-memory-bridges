/**
 * Claude-mem worker 14/15 search API adapter (pure, no Worker calls).
 *
 * v14: /api/mem-search accepts mode=guided|auto, continuation, selectedIds.
 * v15: guided state was deleted; Smart search is now GET /api/search followed
 *      by /api/timeline and /api/observations/batch. The optional one-call,
 *      title-based shallow search is POST /api/dumb-search.
 *
 * Never pretend a v14 continuation remains valid on v15.
 */
const MAX_QUERY_BYTES = 1024;
const PRE_V15_PATH = '/api/mem-search';
const V15_DUMB_PATH = '/api/dumb-search';

export function workerSearchMajor(versionResponse) {
  const value = typeof versionResponse === 'string'
    ? versionResponse : versionResponse?.version;
  const match = typeof value === 'string' ? /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(value.trim()) : null;
  const major = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(major) || major < 14) {
    throw new Error('Unknown central Worker version; refusing to guess the search API contract.');
  }
  return major;
}

function queryText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 ||
      Buffer.byteLength(value.trim(), 'utf8') > MAX_QUERY_BYTES) {
    throw new Error('Search query must contain 1–500 characters and at most 1024 UTF-8 bytes.');
  }
  return value.trim();
}
function safeProject(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > 256) {
    throw new Error('Project must be nonempty and at most 256 UTF-8 bytes.');
  }
  return value.trim();
}
function v15Input(args) {
  return {
    query: queryText(args.query),
    ...(args.project !== undefined ? { project: safeProject(args.project) } : {}),
    ...['limit', 'maxDetails', 'depthBefore', 'depthAfter'].reduce((out, field) => {
      if (args[field] !== undefined) out[field] = args[field];
      return out;
    }, {}),
  };
}

export function planDumbSearch(major, args) {
  const body = v15Input(args);
  return major >= 15
    ? { route: V15_DUMB_PATH, method: 'POST', body, step: 'shallow' }
    : { route: PRE_V15_PATH, method: 'POST', body: { ...body, mode: 'auto' }, step: 'legacy-auto' };
}

export function planMemorySearch(major, args) {
  if (major < 15) {
    return { route: PRE_V15_PATH, method: 'POST', body: args, step: 'legacy-progressive' };
  }
  if (args.continuation !== undefined || args.selectedIds !== undefined) {
    throw new Error(
      'Worker 15 removed guided continuation/selectedIds. Start a new mem_search({query}) for an index, ' +
      'then inspect memory_timeline({anchor}) and memory_get_observations({ids}) using verified observation IDs.',
    );
  }
  const body = v15Input(args);
  if (args.mode === 'auto') {
    return { route: V15_DUMB_PATH, method: 'POST', body, step: 'shallow' };
  }
  const query = new URLSearchParams();
  query.set('query', body.query);
  if (body.project !== undefined) query.set('project', body.project);
  if (body.limit !== undefined) query.set('limit', String(body.limit));
  return { route: '/api/search?' + query, method: 'GET', step: 'smart-index' };
}

/** Forward errors from v15's MCP-shaped Worker response instead of hiding them. */
export function formatWorkerSearchResult(raw) {
  if (!raw || !Array.isArray(raw.content)) return null;
  const content = raw.content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => ({ type: 'text', text: item.text }));
  return { content, ...(raw.isError ? { isError: true } : {}) };
}

/**
 * Worker /api/search returns full raw SQLite rows (narrative, facts, metadata,
 * and occasionally raw prompts). Smart search should show ONLY a compact index.
 * Do not forward raw bodies until the agent explicitly selects numeric IDs.
 */
export function compactSmartSearchIndex(raw, args = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.observations) ||
      !Array.isArray(raw.sessions) || !Array.isArray(raw.prompts)) {
    throw new Error('Worker Smart search index response changed; refusing to disclose unbounded raw results.');
  }
  const limit = Number.isInteger(args.limit) && args.limit >= 1 ? Math.min(args.limit, 20) : 20;
  const sources = [
    {kind:'observation', rows:raw.observations, prefix:''},
    {kind:'summary',rows:raw.sessions,prefix:'S'},
    {kind:'prompt',rows:raw.prompts,prefix:'P'},
  ];
  const index = [];
  let position = 0;
  while (index.length < limit && sources.some(source => position < source.rows.length)) {
    for (const source of sources) {
      if (index.length >= limit) break;
      const row = source.rows[position];
      if (!row || !Number.isSafeInteger(row.id) || row.id < 1) continue;
      index.push({
        id: source.prefix + row.id,
        kind: source.kind,
        project: typeof row.project === 'string' ? row.project.slice(0,96) : '',
        title: String(row.title || row.request || row.prompt_text || 'Untitled').slice(0,160),
        ...(typeof row.type === 'string' ? {type:row.type.slice(0,64)} : {}),
        ...(Number.isSafeInteger(row.created_at_epoch) ? {createdAt:row.created_at_epoch} : {}),
      });
    }
    position++;
  }
  const result = {
    searchStep:'smart-index',
    query: typeof args.query === 'string' ? args.query : '',
    index,
    totalResults: Number.isSafeInteger(raw.totalResults) ? raw.totalResults : index.length,
    next: 'Inspect the most relevant numeric observation IDs with memory_timeline({anchor}) / mem_timeline({anchor}), then fetch selected IDs with memory_get_observations({ids}) / mem_get_observations({ids}). S-prefixed summaries and P-prefixed prompts are not observation IDs.',
  };
  return { content: [{type:'text',text:JSON.stringify(result)}], structuredContent:result };
}
