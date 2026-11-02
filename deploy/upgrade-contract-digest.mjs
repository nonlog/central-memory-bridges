#!/usr/bin/env node
// Digest the *actual* bridge and updater sources used with this Worker.
// Test jobs and production must agree, regardless of unrelated docs commits.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const paths=['deploy/claude-mem-weekly-update.sh','deploy/check-worker-upgrade.mjs',
'deploy/upgrade-contract-digest.mjs','deploy/reapply-claude-mem-platform-ui.py',
'deploy/apply-claude-mem-viewer-branding.mjs','deploy/react-mywork-compat.mjs',
'deploy/mywork-status-compat.mjs','deploy/verify-worker-package.mjs',
'deploy/verify-staged-worker-overlay.py','deploy/claude-mem-manual-upgrade.sh',
'.github/workflows/claude-mem-auto-approve.yml'];
const dirs=['chatgpt-mcp/','hermes-provider/','memory-admin-mcp/',
'openclaw-memory-admin/','pi-extension/','droid-marketplace/','recall-bridge/','shared/'];
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root}).toString('utf8').split('\0').filter(Boolean);
for(const f of tracked){
  if(dirs.some(d=>f.startsWith(d)) && /\.(?:mjs|js|cjs|ts|py)$/.test(f) &&
    !f.includes('/.ci/') && !f.endsWith('.test.mjs') && !f.endsWith('.test.ts') &&
    !/\/(?:test|tests)\//.test(f))paths.push(f);
}
const hash=createHash('sha256');
for(const f of [...new Set(paths)].sort()){
  const p=path.join(root,f);
  if(!fs.existsSync(p))throw new Error('Missing deployment contract file '+f);
  hash.update(f+'\0'); hash.update(fs.readFileSync(p)); hash.update('\0');
}
process.stdout.write(hash.digest('hex')+'\n');
