const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseUserEnvironmentValue, readUserEnvironmentValue, ensureToken } =
  require('./hindsight-mcp-bootstrap.cjs');

test('parses Windows REG_SZ and REG_EXPAND_SZ values', () => {
  const listing = '\nHKEY_CURRENT_USER\\Environment\n    HINDSIGHT_API_TOKEN    REG_SZ    unit-test-token\n    OTHER_KEY    REG_EXPAND_SZ    unrelated\n';
  assert.equal(parseUserEnvironmentValue(listing, 'HINDSIGHT_API_TOKEN'), 'unit-test-token');
  assert.equal(parseUserEnvironmentValue(listing, 'OTHER_KEY'), 'unrelated');
  assert.equal(parseUserEnvironmentValue(listing, 'WRONG_KEY'), '');
});

test('reads only the requested HKCU User value', () => {
  let args;
  const result = readUserEnvironmentValue('HINDSIGHT_API_TOKEN', (_exe, argv) => {
    args = argv;
    return '    HINDSIGHT_API_TOKEN    REG_SZ    from-user-store\r\n';
  });
  assert.equal(result, 'from-user-store');
  assert.deepEqual(args, ['query', 'HKCU\\Environment', '/v', 'HINDSIGHT_API_TOKEN']);
});

test('Windows user token overrides stale inherited process token', () => {
  const env = { HINDSIGHT_API_TOKEN: 'stale-value' };
  assert.equal(ensureToken(env, {
    platform: 'win32',
    reader: key => key === 'HINDSIGHT_API_TOKEN' ? 'current-user-token' : '',
  }), true);
  assert.equal(env.HINDSIGHT_API_TOKEN, 'current-user-token');
});

test('unavailable user token falls back to a process token', () => {
  const env = { HINDSIGHT_API_KEY: 'process-only-token' };
  assert.equal(ensureToken(env, { platform: 'win32', reader: () => '' }), true);
  assert.equal(env.HINDSIGHT_API_TOKEN, 'process-only-token');
});

test('missing credentials fail closed', () => {
  assert.equal(ensureToken({}, { platform: 'win32', reader: () => '' }), false);
});
