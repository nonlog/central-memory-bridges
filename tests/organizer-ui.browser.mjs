// Run against official prebuilt UI assets in GitHub Actions; fixture contains no user data.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const root=process.env.CM_UI_FIXTURE;if(!root)throw Error('CM_UI_FIXTURE required');
const repo=process.cwd();const out=path.join(repo,'browser-evidence');fs.mkdirSync(out,{recursive:true});
const now=Date.now();
const request=(id,label)=>({id:JSON.stringify(['conversation','pi',id]),conversationKey:JSON.stringify(['conversation','pi',id]),conversationKeys:[JSON.stringify(['conversation','pi',id])],original:{text:'Review the completed example project',source:'user-prompt',sourceId:1,url:'/api/work-view/evidence/prompt/1',promptNumber:1,atEpoch:now-3600000},scopeUpdates:[],projects:['example'],agentIds:[],items:[],workstreams:[],updatedAtEpoch:now-1800000,explicitRequestId:null,groupId:null,workProduct:[],activity:[],lifecycle:null,startedAtEpoch:now-3600000,progress:null,completedAtEpoch:null,contentFingerprint:id,review:{checked:false},bridgeRun:{state:'session-idle',label,lastActivityAt:now-1800000,sessionCompletedAt:now-1800000,live:false}});
const snapshot={version:1,generatedAt:new Date().toISOString(),currentProject:null,currentProjectScope:null,agents:[],recentActivity:[],goals:null,goalHistory:[],rules:[],ruleScopes:[],rulesLearning:null,humanRequests:[request('example-ended','Session idle'),request('example-recorded','Recorded only')],unlinkedWork:[],coverage:{livePresenceAvailable:false,workRows:0,observations:0,summaries:0},revision:'fixture',teamMode:false,story:null,refresh:{state:'idle',reason:'independent-organizer',error:null},source:{kind:'claude-mem-recorded-agent-activity',mode:'read-only-sqlite',connected:true,pollIntervalMs:1000,lastCheckedAt:new Date().toISOString(),lastUpdatedAt:new Date().toISOString(),error:null,stale:false},copyRevision:0,rulesFile:{exists:false}};
const overview={projects:[{project:'conduit',label:'Conduit',category:'desktop',count:120},{project:'claude-mem',label:'Claude-mem',category:'memory',count:80}],categories:{desktop:'Windows & desktop',memory:'Memory systems'},totals:{observation:130,prompt:40,summary:20,session:10},review:0,reviewed:200,aliases:14,reviewProgress:{state:'complete',target:200,reviewed:200}};
const record={kind:'observation',id:12,title:'Completed session remains inactive after its final response',excerpt:'Original records are unchanged. The display reflects recorded state, not an inferred running process.',project:'conduit',category:'desktop',platform:'pi',method:'context-reviewed',confidence:.98,tags:'[]',created_at_epoch:now};
function json(res,data){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data))}
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://fixture');
 if(url.pathname==='/api/work-view')return json(res,snapshot);
 if(url.pathname==='/api/work-view/events'){res.setHeader('Content-Type','text/event-stream');return res.end('event: work-view\ndata: '+JSON.stringify(snapshot)+'\n\n')}
 if(url.pathname==='/organizer/api/overview')return json(res,overview);
 if(url.pathname==='/organizer/api/records')return json(res,{items:[record],total:1,hasMore:false});
 if(url.pathname==='/organizer/api/record')return json(res,{record:{id:12,project:'Conduit',title:record.title,narrative:'Original fixture record.'}});
 let file;if(url.pathname==='/'||url.pathname==='/work-view/')file=path.join(root,'plugin/ui/work-view/index.html');
 else if(url.pathname.startsWith('/work-view/'))file=path.join(root,'plugin/ui',url.pathname.slice(1));
 else if(url.pathname==='/organizer/')file=path.join(repo,'memory-organizer/index.html');
 else if(url.pathname.startsWith('/organizer/'))file=path.join(repo,'memory-organizer',url.pathname.slice('/organizer/'.length));
 if(!file||!fs.existsSync(file)){res.statusCode=404;return res.end('Not found')}
 const ext=path.extname(file);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[ext]||'text/plain');
 let data=fs.readFileSync(file);if(url.pathname==='/')data=Buffer.from(data.toString().replace('</body>','<script defer src="/organizer/nav.js?v=2"></script></body>'));res.end(data);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',err=>errors.push(err.message));
try{
 await page.goto(base+'/',{waitUntil:'networkidle'});await page.getByText('Session idle',{exact:true}).waitFor({timeout:20000});
 assert.equal(await page.getByText('Working',{exact:true}).count(),0,'ended requests cannot render Working');
 assert.ok(await page.getByText('0 confirmed active').count());
 await page.locator('aside #central-memory-organizer-nav').waitFor();
 const text=await page.locator('#central-memory-organizer-nav').innerText();assert.equal(text,'Memories');
 assert.equal(await page.locator('header #central-memory-organizer-nav').count(),0,'no extra header row');
 const refs=await page.locator('script[type=module]').evaluateAll(nodes=>nodes.map(n=>n.src));assert.ok(refs.some(s=>s.includes('/index-cmb-')),'patched bytes use a new cache key');
 await page.screenshot({path:path.join(out,'my-work.png')});
 await page.locator('#central-memory-organizer-nav').click();await page.getByText(record.title,{exact:true}).waitFor();
 assert.equal(await page.locator('html').getAttribute('lang'),'en');
 assert.equal(await page.locator('.projects button').count(),0,'project selector is not a wall of buttons');
 assert.equal(await page.locator('#projects').count(),1);
 assert.equal(await page.locator('html').evaluate(e=>e.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(out,'memories-dark.png')});
 await page.getByRole('button',{name:'Toggle color theme'}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');await page.screenshot({path:path.join(out,'memories-light.png')});
 await page.locator('.record').click();await page.locator('dialog[open]').waitFor();await page.getByRole('button',{name:'Close record'}).click();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('html').evaluate(e=>e.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(out,'memories-mobile.png')});
 assert.deepEqual(errors,[]);console.log('Browser checks passed: closed sessions, sidebar integration, cache keys, English UI, both themes, details and responsive layout.');
}catch(err){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,6000));throw err}
finally{await browser.close();server.close()}
