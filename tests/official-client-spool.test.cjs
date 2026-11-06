// Real published clients; all data, credentials and HTTP responses are fixtures.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createHash}=require('node:crypto'),{spawn}=require('node:child_process');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const pause=ms=>new Promise(r=>setTimeout(r,ms));

for(const version of ['15.9.0','15.10.0']) test(`official ${version}: offline capture, compatibility hold and exact-ack retry`,async t=>{
  const installed=process.env.CLIENT_PLUGIN_CACHE?path.join(process.env.CLIENT_PLUGIN_CACHE,version):path.join(process.env.CLIENT_PACKAGE_ROOT||'',`client-${version}`,'package/plugin');
  assert.ok(fs.existsSync(path.join(installed,'package.json')),'Provide the published client runtime');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'official-central-client-'));
  const plugin=path.join(root,'plugin'),scripts=path.join(plugin,'scripts'),data=path.join(root,'data'),project=path.join(root,'sample-project');
  for(const p of [scripts,data,project]) fs.mkdirSync(p,{recursive:true});
  fs.copyFileSync(path.join(installed,'package.json'),path.join(plugin,'package.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin,'package.json'))).version,version);
  const preserved=path.join(installed,'scripts/worker-service.central-upstream.cjs');
  fs.copyFileSync(fs.existsSync(preserved)?preserved:path.join(installed,'scripts/worker-service.cjs'),path.join(scripts,'worker-service.central-upstream.cjs'));
  fs.symlinkSync(path.join(installed,'node_modules'),path.join(plugin,'node_modules'),process.platform==='win32'?'junction':'dir');
  const guard=path.join(scripts,'worker-service.cjs');
  fs.copyFileSync(path.join(__dirname,'../deploy/windows/claude-mem-remote-worker-guard.cjs'),guard);
  fs.copyFileSync(path.join(__dirname,'../deploy/windows/central-client-compatibility.json'),path.join(scripts,'central-client-compatibility.json'));
  let worker='16.0.0',mode='accepted',ingests=0;
  const server=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/health')return res.end(JSON.stringify({status:'ok',mcpReady:true,version:worker}));
    if(req.url==='/api/readiness')return res.end('{"status":"ready"}');
    if(req.url==='/api/spool/ingest'){
      let body='';req.on('data',d=>body+=d).on('end',()=>{
        ingests++;assert.equal(req.headers.authorization,'Bearer isolated-test-token');
        const envelope=JSON.parse(body);assert.equal(envelope.protocolVersion,1);assert.equal(envelope.entry.kind,'observation');
        assert.equal(envelope.entry.payload.toolUseId,'fixture-tool');
        const receipt='remote_'+envelope.entry.kind+'-'+createHash('sha256').update(canonical(envelope.entry)).digest('hex');
        res.statusCode=202;res.end(JSON.stringify({protocolVersion:1,status:'accepted',receipt:mode==='bad-ack'?'incorrect':receipt}));
      });return;
    }
    res.statusCode=503;res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const settings={CLAUDE_MEM_RUNTIME:'worker',CLAUDE_MEM_WORKER_HOST:'127.0.0.1',CLAUDE_MEM_WORKER_PORT:String(server.address().port),CLAUDE_MEM_WORKER_AUTOSTART:'false',CLAUDE_MEM_HOOK_SPOOL_TRANSPORT:'http',CLAUDE_MEM_WORKER_INGEST_TOKEN:'isolated-test-token',CLAUDE_MEM_OBSERVER_ENABLED:'true',CLAUDE_MEM_SKIP_TOOLS:''};
  fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify(settings));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,HOME:root,USERPROFILE:root,LOCALAPPDATA:root,APPDATA:root,CLAUDE_MEM_DATA_DIR:data,...settings,CLAUDE_MEM_WORKER_SCRIPT_PATH:guard,DO_NOT_TRACK:'1'};
  const run=(args,input='')=>new Promise((resolve,reject)=>{
    const child=spawn('bun',[guard,...args],{cwd:project,env,stdio:['pipe','pipe','pipe']});let out='',err='';
    child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));child.stdin.end(input);
  });
  t.after(async()=>{await new Promise(r=>server.close(r));await pause(100);const actual=fs.realpathSync(root);assert.ok(actual.startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(actual,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const spool=path.join(data,'state/hook-spool');
  const entries=()=>fs.existsSync(spool)?fs.readdirSync(spool).filter(f=>/^observation-.*\.json$/.test(f)):[];
  const result=await run(['hook','claude-code','observation'],JSON.stringify({session_id:'fixture-session',cwd:project,tool_name:'Bash',tool_input:{command:'echo synthetic fixture'},tool_response:'synthetic fixture',tool_use_id:'fixture-tool'}));
  assert.equal(result.code,0,result.err);
  for(let n=0;n<50&&!entries().length;n++)await pause(100);
  assert.equal(entries().length,1,'Official write handler must persist before any compatibility check');
  await run(['upload-spool']);assert.equal(ingests,0);assert.equal(entries().length,1);
  worker='15.10.0';mode='bad-ack';let retry=await run(['upload-spool']);assert.equal(retry.code,0,retry.err);assert.ok(ingests>0,'Approved capture pair should reach ingest');assert.equal(entries().length,1,'Wrong ack must not delete the event');
  mode='accepted';retry=await run(['upload-spool']);assert.equal(retry.code,0,retry.err);assert.equal(entries().length,0,'Matching ack must complete the official queue handoff');
});
