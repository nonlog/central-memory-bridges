#!/usr/bin/env node
/** Fail closed before touching the Worker. New releases require a successful
 * GitHub Actions compatibility run, an immutable npm dist.integrity value,
 * and the exact same bridge/update source code used by that run.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const arg=k=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:undefined;
const installed=arg('--installed'),candidate=arg('--candidate');
const integrity=arg('--integrity');
const approvalsFile=arg('--approvals');
const semver=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/;
try{
  if(!semver.test(String(installed))||!semver.test(String(candidate)))throw Error('Invalid version arguments');
  if(installed===candidate){console.log('Worker release unchanged');process.exit(0);}
  const policy=JSON.parse(fs.readFileSync(path.join(root,'worker-upgrade-policy.json'),'utf8'));
  if(policy.schemaVersion!==1||!Array.isArray(policy.approvedVersions)||policy.approvedVersions.some(v=>!semver.test(v)))throw Error('Invalid local fallback policy');
  if(policy.approvedVersions.includes(candidate)){
    console.log('Approved previously-reviewed Worker release: '+candidate);process.exit(0);
  }
  if(!approvalsFile||!integrity||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity))throw Error('Missing CI approval or npm integrity');
  const approvals=JSON.parse(fs.readFileSync(approvalsFile,'utf8'));
  if(approvals.schemaVersion!==1||approvals.repository!=='nonlog/central-memory-bridges'||!Array.isArray(approvals.releases))throw Error('Invalid approval provenance');
  const matches=approvals.releases.filter(r=>r.version===candidate);
  if(matches.length!==1)throw Error('No successful CI compatibility approval for '+candidate);
  const entry=matches[0];
  if(entry.integrity!==integrity||entry.workflow!=='claude-mem-auto-approve.yml'||!Number.isSafeInteger(entry.runId)||entry.runId<=0||!/^([a-f0-9]{64})$/.test(entry.contractDigest||''))throw Error('Approval provenance or npm package integrity mismatch');
  const digest=execFileSync(process.execPath,[path.join(root,'upgrade-contract-digest.mjs')],{encoding:'utf8'}).trim();
  if(digest!==entry.contractDigest)throw Error('Deployed bridge/update code differs from CI-tested code');
  console.log(`CI-approved Worker upgrade ${installed} -> ${candidate} (run ${entry.runId})`);
}catch(e){console.error('COMPATIBILITY HOLD: '+e.message);process.exit(78);}
