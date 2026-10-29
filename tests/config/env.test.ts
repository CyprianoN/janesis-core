import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config/env.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';

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

test('accepts APP_ENV=development', () => {
  assert.equal(loadConfig({ APP_ENV: 'development' }).appEnv, 'development');
});

test('accepts APP_ENV=staging and APP_ENV=production', () => {
  assert.equal(loadConfig({ APP_ENV: 'staging' }).appEnv, 'staging');
  assert.equal(loadConfig({ APP_ENV: 'production' }).appEnv, 'production');
});

test('rejects a missing APP_ENV and names the variable', () => {
  const error = failure({});
  assert.deepEqual(variables(error), ['APP_ENV']);
  assert.match(error.message, /APP_ENV/);
});

test('rejects invalid APP_ENV values, including an empty string', () => {
  for (const value of ['test', 'prod', 'Production', '']) {
    assert.deepEqual(variables(failure({ APP_ENV: value })), ['APP_ENV'], JSON.stringify(value));
  }
});

test('does not infer APP_ENV from NODE_ENV', () => {
  assert.deepEqual(variables(failure({ NODE_ENV: 'production' })), ['APP_ENV']);
  assert.deepEqual(variables(failure({ NODE_ENV: 'development' })), ['APP_ENV']);
});

test('errors never disclose supplied values', () => {
  const error = failure({ APP_ENV: SENTINEL });
  const visible = [error.message, JSON.stringify(error.issues), String(error)].join(' ');
  assert.ok(!visible.includes(SENTINEL), 'a supplied value appeared in the error output');
});
