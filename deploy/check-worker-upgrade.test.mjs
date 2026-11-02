import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(root, 'check-worker-upgrade.mjs');
function call(installed, candidate) {
  return spawnSync(process.execPath, [script, '--installed', installed, '--candidate', candidate], {encoding:'utf8'});
}
test('unchanged worker releases do not need migration approval', () => {
  assert.equal(call('14.0.1','14.0.1').status, 0);
});
test('v15 search API is held before automatic production update', () => {
  const r = call('14.0.1','15.0.1');
  assert.equal(r.status,78);
  assert.match(r.stderr,/COMPATIBILITY HOLD/);
});
test('reviewed v15.1.0 upgrade is approved while future versions fail closed', () => {
  assert.equal(call('14.0.1','15.0.2').status, 0);
  assert.equal(call('15.0.2','15.1.0').status, 0);
  assert.equal(call('15.1.0','15.1.1').status, 78);
  assert.equal(call('14.0.1','15.0.3').status, 78);
  assert.equal(call('14.0.1','16.0.0').status, 78);
});
test('unexpected semver or absent candidate fails closed', () => {
  assert.equal(call('14.0.1','').status, 78);
  assert.equal(call('14.0.1','v15.0.1').status, 78);
});

// CI approval cannot be forged by a version number alone: exact npm artifact,
// run provenance and currently deployed source must all agree.
import fs from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
test('CI-approved candidate requires identical package integrity and deployed sources', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-mem-gate-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manifest=path.join(dir,'approved.json');
  const digest=execFileSync(process.execPath,[path.join(root,'upgrade-contract-digest.mjs')],{encoding:'utf8'}).trim();
  const integrity='sha512-'+Buffer.alloc(64,42).toString('base64');
  const entry={version:'15.8.3',integrity,contractDigest:digest,workflow:'claude-mem-auto-approve.yml',runId:1234};
  const doc={schemaVersion:1,repository:'nonlog/central-memory-bridges',releases:[entry]};
  const run=(other,env=[])=>{
    fs.writeFileSync(manifest,JSON.stringify(other));
    return spawnSync(process.execPath,[script,'--installed','15.1.0','--candidate','15.8.3','--integrity',integrity,'--approvals',manifest,...env],{encoding:'utf8'});
  };
  assert.equal(run(doc).status,0);
  assert.equal(run({...doc,releases:[{...entry,integrity:'sha512-WRONG'}]}).status,78);
  assert.equal(run({...doc,releases:[{...entry,contractDigest:'f'.repeat(64)}]}).status,78);
  assert.equal(run({...doc,releases:[{...entry,workflow:'untrusted.yml'}]}).status,78);
  assert.equal(run({...doc,releases:[]}).status,78);
});
