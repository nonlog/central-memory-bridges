import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [routesPath, progressivePath] = process.argv.slice(2);
if (!routesPath || !progressivePath) throw new Error('Provide SearchRoutes.ts and progressive-search.ts from pinned v15.0.1 tag');
const routes = readFileSync(routesPath, 'utf8');
const contract = readFileSync(progressivePath, 'utf8');
// Compare to the *released* official API rather than guessing from changelog.
assert.match(routes, /app\.get\('\/api\/search'/, 'v15 smart index exists');
assert.match(routes, /app\.post\('\/api\/dumb-search'/, 'v15 shallow endpoint exists');
assert.match(routes, /app\.get\('\/api\/timeline'/, 'v15 timeline exists');
assert.doesNotMatch(routes, /app\.post\('\/api\/mem-search'/, 'removed guided endpoint must not reappear silently');
assert.match(contract, /export interface ProgressiveSearchInput\s*\{/);
for (const name of ['query', 'project', 'limit', 'maxDetails', 'depthBefore', 'depthAfter']) {
  assert.match(contract, new RegExp('\\b' + name + '\\?:'), name + ' in v15 input');
}
assert.doesNotMatch(contract.split('export interface ProgressiveSearchInput {')[1].split('}')[0], /mode\?|continuation\?|selectedIds\?/, 'v15 no guided continuation');
console.log('Pinned v15.0.1 Worker search route/schema assertions passed');
