import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, PROVIDER_REQUIREMENTS, loadConfig } from '../../src/config/env.js';

// Approved Phase 7 engineering bounds (Technical Lead, WP7-2 Review 1). Not Neon provider limits.
const SENTINEL = 'sentinel-secret-value-7f3a91';
const VALID_URL = 'postgres://user:placeholder@example.invalid/db';
const DEV = { APP_ENV: 'development' };

function failure(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error;
  }
  return assert.fail('expected loadConfig to throw');
}

const variables = (error: ConfigError): string[] =>
  error.issues.map((issue) => issue.variable).sort();

const MALFORMED = ['abc', '', '1.5', '-1', '1e1', '0x5', '+5'];

const CASES: Array<{ name: string; min: number; max: number; bad: string[] }> = [
  { name: 'DB_POOL_MAX', min: 1, max: 20, bad: ['0', '21', ' 5', '5 ', ...MALFORMED] },
  {
    name: 'DB_IDLE_TIMEOUT_MS',
    min: 1000,
    max: 300000,
    bad: ['999', '300001', ' 1000', '1000 ', ...MALFORMED],
  },
  {
    name: 'DB_CONNECTION_TIMEOUT_MS',
    min: 100,
    max: 60000,
    bad: ['99', '60001', ' 100', '100 ', ...MALFORMED],
  },
];

test('applies the documented pool defaults: max 5, idle 10000 ms, connection timeout 5000 ms', () => {
  assert.deepEqual(loadConfig(DEV).databasePool, {
    max: 5,
    idleTimeoutMs: 10000,
    connectionTimeoutMs: 5000,
  });
});

test('parses supplied pool settings as numbers', () => {
  const config = loadConfig({
    ...DEV,
    DB_POOL_MAX: '10',
    DB_IDLE_TIMEOUT_MS: '20000',
    DB_CONNECTION_TIMEOUT_MS: '7000',
  });
  assert.deepEqual(config.databasePool, {
    max: 10,
    idleTimeoutMs: 20000,
    connectionTimeoutMs: 7000,
  });
});

test('accepts the lower and upper bound of every pool setting', () => {
  const keys: Record<string, 'max' | 'idleTimeoutMs' | 'connectionTimeoutMs'> = {
    DB_POOL_MAX: 'max',
    DB_IDLE_TIMEOUT_MS: 'idleTimeoutMs',
    DB_CONNECTION_TIMEOUT_MS: 'connectionTimeoutMs',
  };
  for (const { name, min, max } of CASES) {
    const key = keys[name] as 'max' | 'idleTimeoutMs' | 'connectionTimeoutMs';
    assert.equal(loadConfig({ ...DEV, [name]: String(min) }).databasePool[key], min, name);
    assert.equal(loadConfig({ ...DEV, [name]: String(max) }).databasePool[key], max, name);
  }
});

for (const { name, bad } of CASES) {
  test(
    'rejects out-of-range and malformed ' + name + ' values and names only that variable',
    () => {
      for (const value of bad) {
        assert.deepEqual(
          variables(failure({ ...DEV, [name]: value })),
          [name],
          JSON.stringify(value),
        );
      }
    },
  );
}

test('pool errors never disclose supplied values', () => {
  const error = failure({
    ...DEV,
    DB_POOL_MAX: SENTINEL,
    DB_IDLE_TIMEOUT_MS: SENTINEL,
    DB_CONNECTION_TIMEOUT_MS: SENTINEL,
  });
  assert.deepEqual(variables(error), [
    'DB_CONNECTION_TIMEOUT_MS',
    'DB_IDLE_TIMEOUT_MS',
    'DB_POOL_MAX',
  ]);
  const visible = [error.message, JSON.stringify(error.issues), String(error)].join(' ');
  assert.ok(!visible.includes(SENTINEL), 'a supplied value appeared in the error output');
});

test('the database provider is the only required provider under the current policy', () => {
  assert.equal(PROVIDER_REQUIREMENTS.database, true);
  const others = Object.entries(PROVIDER_REQUIREMENTS).filter(([name]) => name !== 'database');
  assert.ok(others.every(([, required]) => required === false));
});

test('DATABASE_URL is required in staging and production and named when missing', () => {
  for (const appEnv of ['staging', 'production']) {
    assert.deepEqual(variables(failure({ APP_ENV: appEnv })), ['DATABASE_URL'], appEnv);
    const config = loadConfig({ APP_ENV: appEnv, DATABASE_URL: VALID_URL });
    assert.deepEqual(config.providers.database, { url: VALID_URL }, appEnv);
  }
});

test('GUARD: DATABASE_URL stays optional in development', () => {
  assert.deepEqual(loadConfig(DEV).providers, {});
});

test('GUARD: an invalid DATABASE_URL still fails in staging and names only DATABASE_URL', () => {
  const error = failure({ APP_ENV: 'staging', DATABASE_URL: 'http://example.invalid/db' });
  assert.deepEqual(variables(error), ['DATABASE_URL']);
});
