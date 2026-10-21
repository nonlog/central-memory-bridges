import test from 'node:test';
import assert from 'node:assert/strict';
import { workerSearchMajor, planMemorySearch, planDumbSearch, formatWorkerSearchResult } from './worker-search-compat.mjs';

test('accepts known worker versions; fails closed on absent/invalid versions', () => {
  assert.equal(workerSearchMajor({version:'14.0.1'}),14);
  assert.equal(workerSearchMajor({version:'15.0.1'}),15);
  assert.throws(()=>workerSearchMajor({status:'ok'}),/Unknown central Worker version/);
  assert.throws(()=>workerSearchMajor({version:'v15.0.1'}),/Unknown central Worker version/);
});

test('14.x retains guided continuation and auto workflow', () => {
  const args = {mode:'guided',continuation:'ms_123456789012345678901234',selectedIds:['S10',20]};
  assert.deepEqual(planMemorySearch(14,args),{
    route:'/api/mem-search',method:'POST',body:args,step:'legacy-progressive'
  });
  const dumb=planDumbSearch(14,{query:'build',limit:5});
  assert.equal(dumb.route,'/api/mem-search');
  assert.deepEqual(dumb.body,{query:'build',limit:5,mode:'auto'});
});

test('15.x guided returns Smart index; auto uses new optional dumb endpoint', () => {
  assert.deepEqual(planMemorySearch(15,{query:'parser',project:'proj a',limit:8,mode:'guided'}),{
    route:'/api/search?query=parser&project=proj+a&limit=8',method:'GET',step:'smart-index'
  });
  assert.deepEqual(planMemorySearch(15,{mode:'auto',query:'parser',depthBefore:1,maxDetails:2}),{
    route:'/api/dumb-search',method:'POST',
    body:{query:'parser',maxDetails:2,depthBefore:1},step:'shallow'
  });
  assert.deepEqual(planDumbSearch(15,{query:'parser',project:'demo'}),{
    route:'/api/dumb-search',method:'POST',body:{query:'parser',project:'demo'},step:'shallow'
  });
});

test('15.x rejects stale continuations, selected IDs and invalid UTF-8 byte counts', () => {
  assert.throws(()=>planMemorySearch(15,{continuation:'ms_123456789012345678901234'}),/removed guided continuation/);
  assert.throws(()=>planMemorySearch(15,{query:'x',selectedIds:[]}),/removed guided continuation/);
  assert.throws(()=>planMemorySearch(15,{query:'汉'.repeat(350)}),/1024 UTF-8 bytes/);
  assert.throws(()=>planDumbSearch(15,{query:'   '}),/Search query/);
});

test('upstream MCP-shaped search errors remain errors', () => {
  assert.deepEqual(formatWorkerSearchResult({content:[{type:'text',text:'retry'}],isError:true}),
    {content:[{type:'text',text:'retry'}],isError:true});
  assert.equal(formatWorkerSearchResult({observations:[]}),null);
});

test('Smart index projects only safe metadata, never raw facts/narratives or prompts', async () => {
  const {compactSmartSearchIndex} = await import('./worker-search-compat.mjs');
  const raw = {
    observations:[{id:10,title:'Bugfix',project:'x',narrative:'VERY_PRIVATE_CONTENT',facts:'KEY=secret'}],
    sessions:[{id:8,request:'Summary request',project:'x',completed:'VERY_PRIVATE_CONTENT'}],
    prompts:[{id:2,prompt_text:'private prompt contents',project:'x',metadata:'VERY_PRIVATE_CONTENT'}],
    totalResults:3,
  };
  const output=compactSmartSearchIndex(raw,{query:'bug',limit:3});
  assert.deepEqual(output.structuredContent.index.map(x=>x.id),['10','S8','P2']);
  assert.equal(output.structuredContent.index[1].kind,'summary');
  assert.ok(!JSON.stringify(output).includes('VERY_PRIVATE_CONTENT'));
  assert.match(output.content[0].text,/memory_timeline/);
  assert.throws(()=>compactSmartSearchIndex({observations:[]}),/response changed/);
});
