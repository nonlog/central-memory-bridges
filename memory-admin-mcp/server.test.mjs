import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP refuses unreviewed deletion and requires a one-use preview receipt', async t => {
  const requests=[];
  const worker=http.createServer((req,res)=>{
    requests.push({method:req.method,url:req.url});
    res.setHeader('content-type','application/json');
    if(req.method==='GET' && req.url==='/api/observation/8') {
      res.end(JSON.stringify({id:8,title:'Sample observation',project:'demo'})); return;
    }
    if(req.method==='DELETE' && req.url==='/api/observation/8') {
      res.end(JSON.stringify({ok:true})); return;
    }
    res.statusCode=404;res.end(JSON.stringify({error:'missing'}));
  });
  await new Promise(resolve=>worker.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>worker.close(resolve)));
  const port=worker.address().port;
  const transport=new StdioClientTransport({
    command:process.execPath,
    args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],
    env:{...process.env,CLAUDE_MEM_WORKER_URL:'http://127.0.0.1:'+port},
  });
  const client=new Client({name:'admin-smoke',version:'1.0.0'});
  await client.connect(transport);
  t.after(async()=>{await client.close()});
  const toolNames=(await client.listTools()).tools.map(tool=>tool.name);
  assert.ok(toolNames.includes('claude_mem_preview_delete'));
  assert.ok(toolNames.includes('claude_mem_forget'));
  const items=[{type:'observation',id:8}];
  const unreviewed=await client.callTool({name:'claude_mem_forget',arguments:{items,previewToken:'X'.repeat(43),confirmationText:'DELETE 1 RECORD',confirm:true}});
  assert.equal(unreviewed.isError,true);
  assert.equal(requests.length,0);
  const preview=await client.callTool({name:'claude_mem_preview_delete',arguments:{items}});
  assert.equal(preview.structuredContent.operation,'preview-only');
  assert.equal(requests.length,1);
  assert.equal(requests[0].method,'GET');
  const accepted=await client.callTool({name:'claude_mem_forget',arguments:{
    items,previewToken:preview.structuredContent.previewToken,
    confirmationText:preview.structuredContent.confirmationText,confirm:true,
  }});
  assert.equal(accepted.structuredContent.ok,true);
  assert.equal(requests.filter(req=>req.method==='DELETE').length,1);
  const replay=await client.callTool({name:'claude_mem_forget',arguments:{
    items,previewToken:preview.structuredContent.previewToken,
    confirmationText:preview.structuredContent.confirmationText,confirm:true,
  }});
  assert.equal(replay.isError,true);
  assert.equal(requests.filter(req=>req.method==='DELETE').length,1);
});
