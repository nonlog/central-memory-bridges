import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContext, candidatesFromClaude, candidatesFromHindsight,
  chooseBanks, modeFor, projectFor, rankAndDedup, readConfig, redact, unifiedRecall,
} from './core.mjs';

const CONF = {
  mode: 'shadow', timeoutMs: 3000, maxChars: 2300, maxCandidates: 8,
  maxBanks: 5, searchLimit: 4, budget: 'low',
  workerUrl: 'https://claude-mem.example.test',
  hindsightUrl: 'https://hindsight.example.test',
  hindsightTokenEnv: 'HINDSIGHT_API_TOKEN',
};

test('readConfig validates mode and scheme', () => {
  assert.equal(readConfig({ configPath: '/no-such-file.json' }).mode, 'shadow');
  const dir = mkdtempSync(join(tmpdir(), 'unified-recall-'));
  try {
    const p = join(dir, 'invalid.json');
    writeFileSync(p, JSON.stringify({ mode: 'bad' }));
    assert.throws(() => readConfig({ configPath: p }), /Unsupported/);
    writeFileSync(p, JSON.stringify({ mode: 'inject', workerUrl: 'http://arbitrary.example.test' }));
    assert.throws(() => readConfig({ configPath: p }), /HTTPS or loopback/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-harness modes allow staged rollout', () => {
  const cfg = {mode:'shadow',modes:{pi:'inject',codex:'off'}};
  assert.equal(modeFor(cfg,'pi'),'inject');
  assert.equal(modeFor(cfg,'codex'),'off');
  assert.equal(modeFor(cfg,'claude-code'),'shadow');
});

test('canonical project Bank is stable across Git worktrees', () => {
  const main = projectFor('D:/Workspace/Conduit', {
    gitCommand: (_, args) => args.includes('--git-common-dir')
      ? 'D:/Workspace/Conduit/.git' : 'D:/Workspace/Conduit',
  });
  const wt = projectFor('D:/Workspace/Conduit-tauri-desktop', {
    gitCommand: (_, args) => args.includes('--git-common-dir')
      ? 'D:/Workspace/Conduit/.git' : 'D:/Workspace/Conduit-tauri-desktop',
  });
  assert.equal(main.currentBank, 'coding-agent::Conduit');
  assert.equal(wt.currentBank, main.currentBank);
  const unmapped = projectFor('D:/Workspace', { gitCommand: () => '' });
  assert.equal(unmapped.currentBank, 'agent-central');
});

test('explicit project words and Claude-mem project matches route banks', () => {
  const banks = ['agent-central', 'coding-agent::Conduit', 'coding-agent::OPlusFluidCompat', 'coding-agent::PixelAOD'];
  const result = chooseBanks({
    banks, query: 'Reuse the OPlusFluidCompat compatibility fix in Conduit',
    currentBank: 'coding-agent::Conduit', maxBanks: 3,
  });
  assert.deepEqual(result, ['coding-agent::Conduit','agent-central','coding-agent::OPlusFluidCompat']);
  const inferred = chooseBanks({
    banks, query: 'How did we fix the foreground notification lifecycle?',
    currentBank: 'coding-agent::Conduit', maxBanks: 3,
    workerProjects: ['pixel-aod'],
  });
  assert(inferred.includes('coding-agent::PixelAOD'));
});

test('migrated Claude-mem document IDs deduplicate Hindsight originals', () => {
  const fromWorker = candidatesFromClaude({
    observations: [{id: 37438, title: 'Fixed Conduit transfers', narrative: 'Durable fix for interrupted transfers', project:'conduit'}],
    sessions: [{id: 83, learned: 'Transfers require cancellation'}],
  });
  const fromHindsight = candidatesFromHindsight('agent-central', {
    results: [
      {id:'h-1',document_id:'cm-observation-00037438',text:'Fixed Conduit transfers, durable fix for interrupted transfers',scores:{final:.95}},
      {id:'h-2',document_id:'cm-summary-00000083',text:'Transfers require cancellation',scores:{final:.9}},
    ],
  });
  assert.equal(fromWorker.length,2);
  assert.equal(fromHindsight[0].key,'obs:37438');
  assert.equal(fromHindsight[1].key,'summary:83');
  assert.equal(rankAndDedup([...fromWorker,...fromHindsight], {query:'transfers'}).length,2);
});

test('secret redaction and token budget preserve source attribution', () => {
  const source = {
    source:'claude-mem',kind:'obs',id:8,
    text:'Historical note key: sk-' + 'a'.repeat(24) + ' — ' + 'important details '.repeat(70),
  };
  assert(!redact(source.text).includes('sk-' + 'a'.repeat(24)));
  const context = buildContext([source], 850);
  assert(context.includes('[Claude-mem obs#8]'));
  assert(context.includes('untrusted reference data'));
  assert(context.length <= 850);
  assert(!context.includes('sk-' + 'a'.repeat(24)));
});

test('unifiedRecall reads global Claude-mem and several project banks, no writes', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const name = new URL(url).pathname;
    calls.push({name, method: options.method || 'GET'});
    const response = body => ({ok:true,json:async()=>body});
    if (name === '/api/search') return response({
      observations:[{id:42,title:'OPlus Android compatibility issue',narrative:'A shared compatibility solution',project:'oplusfluidcompat'}],
      sessions:[],prompts:[],
    });
    if (name === '/v1/default/banks') return response({banks:[
      {bank_id:'agent-central'},{bank_id:'coding-agent::Conduit'},
      {bank_id:'coding-agent::OPlusFluidCompat'},
    ]});
    const bank = decodeURIComponent(name.split('/banks/')[1].split('/memories')[0]);
    if (bank === 'agent-central') return response({results:[{
      id:'m1',document_id:'cm-observation-00000042',text:'A shared compatibility solution from Claude-mem',scores:{final:0.8},
    }]});
    return response({results:[{
      id:'p-'+bank,document_id:'code:'+bank,text:bank+' project-specific workaround and checks',scores:{final:0.92},
    }]});
  };
  const result = await unifiedRecall({
    prompt: 'What OPlusFluidCompat compatibility design can be reused by Conduit?',
    cwd: 'D:/Workspace/Conduit',harness:'codex',
  }, {
    config: CONF, fetcher, env:{HINDSIGHT_API_TOKEN:'test-value'},
    projectResolver:()=>({project:'Conduit',currentBank:'coding-agent::Conduit'}),
  });
  assert(result.diagnostic.banks.includes('coding-agent::OPlusFluidCompat'));
  assert(result.diagnostic.banks.includes('agent-central'));
  assert(result.context.includes('unified-memory-context'));
  assert.equal(result.diagnostic.failures.length,0);
  assert(calls.filter(x=>x.method==='POST').every(x=>x.name.endsWith('/memories/recall')));
  assert.equal(result.diagnostic.candidates,4);
  assert.equal(result.diagnostic.selected,3);
});

test('Claude-mem current-project startup history is not injected twice', async () => {
  const fetcher=async url => {
    if (url.includes('/api/search')) return {ok:true,json:async()=>({
      observations:[
        {id:1,project:'Conduit',title:'Conduit old tool trace',narrative:'Already injected on SessionStart'},
        {id:2,project:'OPlusFluidCompat',title:'A cross project lesson',narrative:'Useful for Conduit'},
      ],sessions:[],prompts:[],
    })};
    if (url.endsWith('/banks')) return {ok:true,json:async()=>({banks:[{bank_id:'agent-central'}]})};
    return {ok:true,json:async()=>({results:[]})};
  };
  const cfg={...CONF,mode:'inject'};
  const p=()=>({project:'Conduit',currentBank:'coding-agent::Conduit'});
  const codex=await unifiedRecall({prompt:'What prior decisions help Conduit?',cwd:'D:/Workspace/Conduit',harness:'codex'},{
    config:cfg,fetcher,env:{HINDSIGHT_API_TOKEN:'test-token'},projectResolver:p,
  });
  const pi=await unifiedRecall({prompt:'What prior decisions help Conduit?',cwd:'D:/Workspace/Conduit',harness:'pi'},{
    config:cfg,fetcher,env:{HINDSIGHT_API_TOKEN:'test-token'},projectResolver:p,
  });
  assert(!codex.context.includes('Conduit old tool trace'));
  assert(codex.context.includes('A cross project lesson'));
  assert(pi.context.includes('Conduit old tool trace'));
});

test('failing Hindsight degrades to Claude-mem without breaking agent', async () => {
  const fetcher = async url => {
    if (url.includes('claude-mem.')) return {ok:true,json:async()=>({
      observations:[{id:2,title:'Preserve coding history',narrative:'Captured by Claude-mem'}],sessions:[],prompts:[],
    })};
    throw new TypeError('network unavailable');
  };
  const result=await unifiedRecall({prompt:'How was coding history preserved?',cwd:'C:/tmp'},{
    config:CONF,fetcher,env:{HINDSIGHT_API_TOKEN:'test-token'},
    projectResolver:()=>({project:'',currentBank:'agent-central'}),
  });
  assert(result.context.includes('Claude-mem obs#2'));
  assert(result.diagnostic.failures.some(x=>x.startsWith('bank-list:')));
});

test('cold or not-yet-created Bank is skipped after successful Bank listing', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes('/api/search')) return {ok:true,json:async()=>({observations:[],sessions:[],prompts:[]})};
    if (url.endsWith('/banks')) return {ok:true,json:async()=>({banks:[{bank_id:'agent-central'}]})};
    if (url.includes('/agent-central/memories/recall')) return {ok:true,json:async()=>({results:[{
      id:'mem1',text:'History in the shared Bank',document_id:'cm-summary-00000001',
    }]})};
    throw Error('Unexpected new project Bank lookup');
  };
  const result = await unifiedRecall({prompt:'Find prior architecture decisions',cwd:'/fake'},{
    config:CONF,fetcher,env:{HINDSIGHT_API_TOKEN:'test-token'},
    projectResolver:()=>({project:'NotCreated',currentBank:'coding-agent::NotCreated'}),
  });
  assert(result.context.includes('agent-central'));
  assert(!calls.some(x=>x.includes('NotCreated/memories')));
  assert.equal(result.diagnostic.failures.length,0);
});

test('disabled or invalid prompts make no requests', async () => {
  let calls=0;
  const r=await unifiedRecall({prompt:'What?',cwd:'/tmp'},{
    config:{...CONF,mode:'off'},fetcher:async()=>{calls++;},
  });
  assert.equal(calls,0);
  assert.equal(r.context,'');
});
