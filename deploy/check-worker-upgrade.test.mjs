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
test('reviewed 15.0.2 upgrade is approved while later versions fail closed', () => {
  assert.equal(call('14.0.1','15.0.2').status, 0);
  assert.equal(call('14.0.1','15.0.3').status, 78);
  assert.equal(call('14.0.1','16.0.0').status, 78);
});
test('unexpected semver or absent candidate fails closed', () => {
  assert.equal(call('14.0.1','').status, 78);
  assert.equal(call('14.0.1','v15.0.1').status, 78);
});
