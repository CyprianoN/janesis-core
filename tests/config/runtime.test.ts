import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config/env.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';
const base = { APP_ENV: 'development' };

function failure(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error;
  }
  return assert.fail('expected loadConfig to throw');
}

const variables = (error: ConfigError): string[] => error.issues.map((issue) => issue.variable);

test('applies the documented defaults: PORT 8080 and SHUTDOWN_TIMEOUT_MS 8000', () => {
  assert.deepEqual(loadConfig(base), {
    appEnv: 'development',
    port: 8080,
    shutdownTimeoutMs: 8000,
    providers: {},
    databasePool: { max: 5, idleTimeoutMs: 10000, connectionTimeoutMs: 5000 },
  });
});

test('parses PORT and SHUTDOWN_TIMEOUT_MS as numbers', () => {
  const config = loadConfig({ ...base, PORT: '3000', SHUTDOWN_TIMEOUT_MS: '5000' });
  assert.equal(config.port, 3000);
  assert.equal(config.shutdownTimeoutMs, 5000);
});

test('accepts the PORT boundaries 1 and 65535', () => {
  assert.equal(loadConfig({ ...base, PORT: '1' }).port, 1);
  assert.equal(loadConfig({ ...base, PORT: '65535' }).port, 65535);
});

test('rejects malformed PORT values and names the variable', () => {
  const bad = ['0', '65536', '-1', '80.5', 'abc', '', ' 8080', '8080 ', '0x1F90', '1e3'];
  for (const value of bad) {
    assert.deepEqual(variables(failure({ ...base, PORT: value })), ['PORT'], JSON.stringify(value));
  }
});

test('rejects malformed SHUTDOWN_TIMEOUT_MS values and names the variable', () => {
  const bad = ['0', '-5', '1.5', 'abc', '', ' 8000', '8e3'];
  for (const value of bad) {
    assert.deepEqual(
      variables(failure({ ...base, SHUTDOWN_TIMEOUT_MS: value })),
      ['SHUTDOWN_TIMEOUT_MS'],
      JSON.stringify(value),
    );
  }
});

test('reports every invalid variable, not only the first', () => {
  const error = failure({ APP_ENV: 'nope', PORT: 'x', SHUTDOWN_TIMEOUT_MS: 'y' });
  assert.deepEqual(variables(error).sort(), ['APP_ENV', 'PORT', 'SHUTDOWN_TIMEOUT_MS']);
});

test('errors for PORT and SHUTDOWN_TIMEOUT_MS never disclose supplied values', () => {
  const error = failure({ ...base, PORT: SENTINEL, SHUTDOWN_TIMEOUT_MS: SENTINEL });
  const visible = [error.message, JSON.stringify(error.issues), String(error)].join(' ');
  assert.ok(!visible.includes(SENTINEL), 'a supplied value appeared in the error output');
});

test('ignores unrelated environment variables', () => {
  assert.deepEqual(loadConfig({ ...base, UNRELATED: 'x', NODE_ENV: 'production' }), {
    appEnv: 'development',
    port: 8080,
    shutdownTimeoutMs: 8000,
    providers: {},
    databasePool: { max: 5, idleTimeoutMs: 10000, connectionTimeoutMs: 5000 },
  });
});
