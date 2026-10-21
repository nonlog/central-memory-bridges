#!/usr/bin/env node
/**
 * Pre-flight gate: fail closed BEFORE stopping Worker or creating backups.
 * An unapproved upstream release must never be installed by unattended runs.
 * This does not edit any credentials or start/stop any service.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = process.argv[process.argv.indexOf('--installed') + 1];
const candidate = process.argv[process.argv.indexOf('--candidate') + 1];
const root = path.dirname(fileURLToPath(import.meta.url));
const policyFile = path.join(root, 'worker-upgrade-policy.json');
const versionRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/;

try {
  if (!versionRegex.test(String(installed)) || !versionRegex.test(String(candidate))) {
    throw new Error('Invalid Worker version or missing --installed/--candidate');
  }
  if (installed === candidate) {
    console.log('Worker release unchanged; no compatibility migration required');
    process.exit(0);
  }
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.approvedVersions) ||
      policy.approvedVersions.some(v => !versionRegex.test(String(v)))) {
    throw new Error('Unrecognized or invalid compatibility approval manifest');
  }
  if (!policy.approvedVersions.includes(candidate)) {
    console.error('COMPATIBILITY HOLD: claude-mem ' + candidate +
      ' has not passed the current bridge upgrade review; Worker remains on ' + installed);
    process.exit(78);
  }
  console.log('Approved Worker upgrade ' + installed + ' -> ' + candidate);
} catch (error) {
  console.error('COMPATIBILITY HOLD: ' + error.message);
  process.exit(78);
}
