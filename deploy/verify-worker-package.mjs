#!/usr/bin/env node
/** Inspect the exact official npm package that production will install.
 * This is additive to existing bridge tests and the isolated UI overlay test.
 * A removed route or spool/auth contract must fail the approval job.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.argv[2];
if(!root)throw Error('Usage: node deploy/verify-worker-package.mjs <extracted-npm-package>');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const pkg=JSON.parse(read('package.json'));
const plugin=JSON.parse(read('plugin/package.json'));
assert.match(pkg.version,/^\d+\.\d+\.\d+$/);
assert.equal(plugin.version,pkg.version,'Worker package and plugin must share a version');
const worker=read('plugin/scripts/worker-service.cjs');
const mcp=read('plugin/scripts/mcp-server.cjs');
read('plugin/scripts/claude-mem-launcher.cjs');
read('plugin/ui/viewer-bundle.js');
read('plugin/ui/viewer.html');
read('plugin/ui/work-view/index.html');
const routeChecks=[
  ['GET observation','r.get("/api/observation/:id"'],
  ['DELETE observation','r.delete("/api/observation/:id"'],
  ['POST batch observations','r.post("/api/observations/batch"'],
  ['GET search','r.get("/api/search"'],
  ['GET timeline','r.get("/api/timeline"'],
  ['POST spool ingest','r.post("/api/spool/ingest"'],
  ['GET search observations','r.get("/api/search/observations"'],
  ['GET session','r.get("/api/session/:id"'],
];
for(const [name,token] of routeChecks){
  assert.ok(worker.includes(token),`Official package changed ${name} contract`);
}
for(const route of ['/api/sessions/init','/api/sessions/observations','/api/sessions/summarize',
  '/api/observations','/api/readiness','/api/health']){
  assert.ok(worker.includes(route),`Missing official Worker route ${route}`);
}
for(const text of ['/api/spool/ingest','protocolVersion','contentSessionId','platformSource']){
  assert.ok(worker.includes(text),`Official hook/spool contract changed: ${text}`);
}
assert.ok(mcp.includes('tools/list')&&mcp.includes('tools/call'),'Native MCP request dispatch removed');
assert.match(read('plugin/ui/work-view/index.html'),/\/work-view\/assets\/index-[^" ]+\.js/);
const html=read('plugin/ui/work-view/index.html');
const entry=/\/work-view\/assets\/(index-[A-Za-z0-9_.-]+\.js)/.exec(html);
assert.ok(entry,'Official React My Work entry is missing');
const assetsDir='plugin/ui/work-view/assets';
const assetFiles=fs.readdirSync(path.join(root,assetsDir)).filter(f=>f.endsWith('.js'));
assert.ok(assetFiles.length>0,'Official React My Work assets are missing');
// 15.16.0 code-split the My Work UI: the status mapper moved out of the entry
// bundle into a lazy chunk (ui-message-*.js) and the minified variable was
// renamed, so match the mapper shape across all chunks, not one pinned string.
const reactAll=assetFiles.map(f=>read(path.join(assetsDir,f))).join('\n');
assert.ok(/id:[A-Za-z_$][\w$]*\.id,contentFingerprint:[A-Za-z_$][\w$]*\.contentFingerprint,/.test(reactAll),'Real My Work status mapper disappeared');
assert.ok(reactAll.includes('case`unknown`:return{state:'),'My Work unknown state contract changed');
console.log(`Checked actual claude-mem ${pkg.version} npm Worker HTTP/MCP/hook/spool package contracts`);
