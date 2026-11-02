#!/usr/bin/env node
// Only invoked after the version-specific GitHub Actions package/bridge tests.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const version=process.env.CLAUDE_MEM_CANDIDATE_VERSION;
const integrity=process.env.CLAUDE_MEM_CANDIDATE_INTEGRITY;
const runId=Number(process.env.GITHUB_RUN_ID);
if(!/^\d+\.\d+\.\d+$/.test(version||'')||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity||'')||!Number.isSafeInteger(runId)||runId<=0||process.env.GITHUB_REF!=='refs/heads/master'||!process.env.GITHUB_ACTIONS)throw Error('Only authenticated master CI runs may approve new releases');
const digest=execFileSync(process.execPath,[path.join(root,'upgrade-contract-digest.mjs')],{encoding:'utf8'}).trim();
const filename=path.join(root,'worker-upgrade-approvals.json');
const doc=JSON.parse(fs.readFileSync(filename,'utf8'));
if(doc.schemaVersion!==1||doc.repository!=='nonlog/central-memory-bridges'||!Array.isArray(doc.releases))throw Error('Invalid release manifest');
doc.releases=doc.releases.filter(r=>r.version!==version);
doc.releases.push({version,integrity,contractDigest:digest,workflow:'claude-mem-auto-approve.yml',runId});
doc.releases.sort((a,b)=>a.version.localeCompare(b.version,undefined,{numeric:true}));
// Retain a small rollback/review history, not an ever-growing approval list.
doc.releases=doc.releases.slice(-8);
fs.writeFileSync(filename,JSON.stringify(doc,null,2)+'\n');
console.log('Approved CI-tested claude-mem '+version+' for contract '+digest);
