const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseUserEnvironmentValue, readUserEnvironmentValue, ensureToken, ensureProxyEnvironment } =
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


test('Windows proxy reload replaces a stale inherited direct-connection environment', () => {
  const env = { HTTPS_PROXY: 'http://old.invalid:9911', NODE_USE_ENV_PROXY: '0' };
  const values = {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost,127.0.0.1',
    NODE_USE_ENV_PROXY: '1',
  };
  ensureProxyEnvironment(env, { platform: 'win32', reader: key => values[key] || '' });
  assert.equal(env.HTTPS_PROXY, values.HTTPS_PROXY);
  assert.equal(env.HTTP_PROXY, values.HTTP_PROXY);
  assert.equal(env.NO_PROXY, values.NO_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});

test('enables Node proxy support when Windows user proxy is present but flag absent', () => {
  const env = {};
  ensureProxyEnvironment(env, {
    platform: 'win32',
    reader: key => key === 'HTTPS_PROXY' ? 'http://127.0.0.1:7890' : '',
  });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});

test('preserves explicitly disabled proxy when HKCU contains no override', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:10080', NODE_USE_ENV_PROXY: '0' };
  ensureProxyEnvironment(env, { platform: 'win32', reader: () => '' });
  assert.equal(env.NODE_USE_ENV_PROXY, '0');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:10080');
});

test('does not rewrite proxy on non-Windows systems', () => {
  const env = { NODE_USE_ENV_PROXY: '0' };
  ensureProxyEnvironment(env, {
    platform: 'linux',
    reader: () => { throw new Error('must not inspect Windows registry'); },
  });
  assert.deepEqual(env, { NODE_USE_ENV_PROXY: '0' });
});
