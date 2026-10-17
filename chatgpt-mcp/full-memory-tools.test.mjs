import assert from 'node:assert/strict';
import test from 'node:test';
import { registerWorkerMemoryTools, validateWorkStateFields } from './full-memory-tools.mjs';

function harness(scopes = ['memory:read', 'memory:write'], platform = 'claude-web') {
  const tools = new Map(), calls = [];
  registerWorkerMemoryTools({ registerTool(name, meta, fn) { tools.set(name, { meta, fn }); } }, {
    worker: async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, path };
    },
    platform, defaultProject: platform, scopes,
    safeProject: (x) => x.replace(/[^a-zA-Z0-9_-]/g,'-'),
    redactSecrets: (x) => x,
  });
  return { tools, calls, call: (name, args = {}) => tools.get(name).fn(args) };
}

test('the shared MCP exposes Worker functionality but no raw host proxy', () => {
  const h = harness();
  for (const name of ['mem_search','save_memory','memory_search_advanced','memory_timeline',
    'memory_get_observations','memory_get_tool_uses','memory_list_records','memory_get_record',
    'memory_projects','memory_stats','work_state_read','work_state_write','team_brief',
    'team_search','session_start_context','claude_mem_forget','memory_delete_session',
    'memory_admin_permissions']) assert.equal(h.tools.has(name), true, name);
  assert.equal(h.tools.has('execute_shell'), false);
  assert.equal(h.tools.get('claude_mem_forget').meta.annotations.destructiveHint, true);
});

test('progressive search and raw tool records use Worker routes', async () => {
  const h = harness();
  await h.call('mem_search', { query: 'project history', mode:'guided' });
  await h.call('memory_get_tool_uses', { ids: [44] });
  assert.deepEqual(h.calls.map(x => x.path), ['/api/mem-search','/api/tool-uses/batch']);
  assert.deepEqual(h.calls[0].body, { query:'project history', mode:'guided' });
});

test('manual save assigns verified Claude Web provenance', async () => {
  const h = harness();
  await h.call('save_memory', { text:'New decision', metadata:{ platformSource:'chatgpt', foo:'bar' } });
  assert.equal(h.calls[0].path, '/api/memory/save');
  assert.equal(h.calls[0].body.metadata.platformSource, 'claude-web');
  assert.equal(h.calls[0].body.project, 'claude-web');
});

test('Grok and Claude Web work state uses virtual project path', async () => {
  const h = harness(['memory:read','memory:write'],'grok-web');
  await h.call('work_state_read', {project:'demo'});
  await h.call('work_state_write',{project:'demo',list:'release',fields:{task:'test',status:'doing'}});
  assert.match(h.calls[0].path,/cwd=%2Fweb-mcp%2Fdemo/);
  assert.equal(h.calls[1].body.cwd, '/web-mcp/demo');
});

test('work state validation matches official v13.41 2000-character and safe-number rules', async () => {
  const h = harness();
  assert.equal(validateWorkStateFields({task: 'ok', count: 1.5}), null);
  const max = 2_000 - JSON.stringify({note: ''}).length;
  assert.equal(validateWorkStateFields({note: 'x'.repeat(max)}), null);
  assert.match(validateWorkStateFields({note: 'x'.repeat(max + 1)}), /2000/);
  assert.match(validateWorkStateFields({count: Number.MAX_SAFE_INTEGER + 1}), /safe finite/);
  assert.match(validateWorkStateFields({count: NaN}), /safe finite/);
  assert.match(validateWorkStateFields({count: Infinity}), /safe finite/);
  assert.match(validateWorkStateFields({'': 'invalid'}), /non-empty/);
  assert.match(validateWorkStateFields({}), /non-empty/);
  await h.call('work_state_write', {list: 'a'.repeat(150), fields:{note:'valid'}});
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.call('work_state_write', {list:'todo', fields:{note:'x'.repeat(max+1)}}), /2000/);
  await assert.rejects(h.call('work_state_write', {list:'todo', fields:{count:Number.MAX_SAFE_INTEGER + 1}}), /safe finite/);
  assert.equal(h.calls.length, 1, 'invalid Work State updates never reach Worker');
  const schema = h.tools.get('work_state_write').meta.inputSchema;
  assert.equal(schema.list.safeParse('x'.repeat(200)).success, true);
  assert.equal(schema.list.safeParse('x'.repeat(201)).success, false);
  assert.equal(schema.fields.safeParse({n:Number.MAX_SAFE_INTEGER + 1}).success, false);
});

test('ordinary read/write scopes cannot delete', async () => {
  const h = harness();
  await assert.rejects(h.call('claude_mem_forget',{items:[{type:'observation',id:7}],confirm:true}),/memory:delete OAuth scope required/);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.call('memory_admin_permissions')).structuredContent.can_delete,false);
});

test('deletion uses exact sync-aware Worker paths and deduplicates records', async () => {
  const h = harness(['memory:read','memory:write','memory:delete']);
  const result = await h.call('claude_mem_forget',{items:[{type:'observation',id:7},{type:'observation',id:7},{type:'prompt',id:8},{type:'summary',id:9}],confirm:true});
  assert.deepEqual(h.calls.map(x=>x.path),['/api/observation/7','/api/prompt/8','/api/summary/9']);
  assert.ok(h.calls.every(x=>x.method==='DELETE'));
  assert.equal(result.structuredContent.deleted.length,3);
  await h.call('memory_delete_session',{platformSource:'grok-web',contentSessionId:'grok-web-abc',confirm:true});
  assert.equal(h.calls[3].path,'/api/sessions/grok-web/grok-web-abc');
});

test('Executor save_memory declares a constrained agent identity enum and labels selected source', async () => {
  const h = harness(['memory:read','memory:write'],'executor');
  const tool = h.tools.get('save_memory');
  assert.ok(tool.meta.inputSchema.agent_identity);
  const p = tool.meta.inputSchema.agent_identity.safeParse('codex');
  assert.equal(p.success, true);
  assert.equal(tool.meta.inputSchema.agent_identity.safeParse('unlisted-client').success, false);
  await h.call('save_memory', {text:'a decision', agent_identity:'codex',metadata:{platformSource:'spoof',source:'spoof',via:'spoof'}});
  assert.equal(h.calls[0].body.metadata.platformSource,'codex');
  assert.equal(h.calls[0].body.metadata.source,'codex');
  assert.equal(h.calls[0].body.metadata.via,'executor');
  assert.equal(h.calls[0].body.metadata.identityAttribution,'agent_selected');
  assert.equal((await h.call('memory_admin_permissions')).structuredContent.agent_identity_options.includes('codex'),true);
  assert.equal((await h.call('memory_admin_permissions')).structuredContent.identity_attribution,'agent_selected_not_verified');
});

test('Executor save_memory defaults to Executor and non-Executor schema has no source override', async () => {
  const exec = harness(['memory:read','memory:write'],'executor');
  await exec.call('save_memory',{text:'ordinary message'});
  assert.equal(exec.calls[0].body.metadata.platformSource,'executor');
  const gemini = harness(['memory:read','memory:write'],'gemini');
  assert.equal(gemini.tools.get('save_memory').meta.inputSchema.agent_identity,undefined);
  await gemini.call('save_memory',{text:'web message',agent_identity:'codex'});
  assert.equal(gemini.calls[0].body.metadata.platformSource,'gemini');
});
