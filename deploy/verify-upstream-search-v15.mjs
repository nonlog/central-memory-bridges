import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [routesPath, progressivePath, searchManagerPath] = process.argv.slice(2);
if (!routesPath || !progressivePath || !searchManagerPath) throw new Error('Provide SearchRoutes.ts, progressive-search.ts and SearchManager.ts from the pinned v15 tag');
const routes = readFileSync(routesPath, 'utf8');
const contract = readFileSync(progressivePath, 'utf8');
const searchManager = readFileSync(searchManagerPath, 'utf8');
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
assert.match(routes, /this\.searchManager\.search\(this\.searchArgsFromRequest\(req\)/, 'query including format reaches SearchManager');
assert.match(searchManager, /if \(format === 'json'\)/, 'v15 requires explicit format=json for structured index arrays');
console.log('Pinned v15 Worker search route/schema and format=json assertions passed');
