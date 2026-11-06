const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');

async function fixture(t, client='15.9.0', worker='15.10.0') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'central-client-'));
  const scripts=path.join(root,'scripts'); fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:client}));
  for(const f of ['claude-mem-remote-worker-guard.cjs','central-client-compatibility.json']) fs.copyFileSync(path.join(__dirname,'../deploy/windows',f),path.join(scripts,f==='claude-mem-remote-worker-guard.cjs'?'worker-service.cjs':f));
  fs.writeFileSync(path.join(scripts,'worker-service.central-upstream.cjs'),`const fs=require('fs'),p=require('path');const d=process.env.CLAUDE_MEM_DATA_DIR;fs.writeFileSync(p.join(d,'invoked'),process.argv.slice(2).join(' '));if(process.argv[2]==='hook')fs.writeFileSync(p.join(d,'pending'),'capture');if(process.argv[2]==='upload-spool')fs.writeFileSync(p.join(d,'uploaded'),'yes');console.log(JSON.stringify({script:process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH,autostart:process.env.CLAUDE_MEM_WORKER_AUTOSTART}));`);
  const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/health'?{status:'ok',version:worker,mcpReady:true}:{status:'ready'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const run=(...args)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(scripts,'worker-service.cjs'),...args],{env:{...process.env,CLAUDE_MEM_DATA_DIR:root,CLAUDE_MEM_WORKER_HOST:'127.0.0.1',CLAUDE_MEM_WORKER_PORT:String(server.address()?.port||1),CLAUDE_MEM_HOOK_SPOOL_TRANSPORT:'http'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end('{}');
  });
  return {root,scripts,run,server};
}

test('unknown version preserves captures and holds upload without invoking upstream',async t=>{
  const f=await fixture(t,'15.9.0','16.0.0');
  const capture=await f.run('hook','claude-code','observation');assert.equal(capture.code,0);
  assert.equal(fs.readFileSync(path.join(f.root,'pending'),'utf8'),'capture');
  const env=JSON.parse(capture.stdout);assert.equal(env.autostart,'false');assert.equal(env.script,path.join(f.scripts,'worker-service.cjs'));
  const held=await f.run('upload-spool');assert.equal(held.code,0);assert.match(held.stderr,/queued captures are retained/);
  assert.equal(fs.existsSync(path.join(f.root,'uploaded')),false);assert.equal(fs.existsSync(path.join(f.root,'pending')),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'state/central-client-status.json'))).status,'sync-required');
});
test('verified skew permits capture upload while context explicitly requests local sync',async t=>{
  const f=await fixture(t);const uploaded=await f.run('upload-spool');assert.equal(uploaded.code,0);assert.equal(fs.existsSync(path.join(f.root,'uploaded')),true);
  const context=await f.run('hook','codex','context');const out=JSON.parse(context.stdout);assert.equal(out.hookSpecificOutput.hookEventName,'SessionStart');assert.match(out.systemMessage,/Synchronize this computer/);
});
test('offline capture reaches the official handler and preserves pending data',async t=>{
  const f=await fixture(t);await new Promise(r=>f.server.close(r));
  assert.equal((await f.run('hook','codex','observation')).code,0);assert.equal(fs.existsSync(path.join(f.root,'pending')),true);
  assert.equal((await f.run('upload-spool')).code,0);assert.equal(fs.existsSync(path.join(f.root,'pending')),true);assert.equal(fs.existsSync(path.join(f.root,'uploaded')),false);
});
test('missing policy fails closed for skew, but exact versions remain usable',async t=>{
  const f=await fixture(t);fs.unlinkSync(path.join(f.scripts,'central-client-compatibility.json'));await f.run('upload-spool');assert.equal(fs.existsSync(path.join(f.root,'uploaded')),false);
  const same=await fixture(t,'15.10.0','15.10.0');fs.unlinkSync(path.join(same.scripts,'central-client-compatibility.json'));assert.equal((await same.run('upload-spool')).code,0);assert.equal(fs.existsSync(path.join(same.root,'uploaded')),true);
});
