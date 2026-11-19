import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidErrorDetailsError,
  copySafeDetails,
} from '../../../../src/domain/shared/errors/error.types.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';

function rejection(input: unknown): InvalidErrorDetailsError {
  try {
    copySafeDetails(input);
  } catch (error) {
    assert.ok(error instanceof InvalidErrorDetailsError, 'expected an InvalidErrorDetailsError');
    return error;
  }
  return assert.fail('expected copySafeDetails to throw');
}

// The variants named in the Tech Lead's ruling.
const NAMED_BY_TECH_LEAD = [
  'access_token',
  'refresh_token',
  'client_secret',
  'api_key',
  'private_key',
];

const FURTHER_VARIANTS = [
  'Authorization',
  'authorization',
  'AUTHORIZATION',
  'accessToken',
  'idToken',
  'X-Api-Key',
  'api-key',
  'API KEY',
  'apiKey',
  'x_api_key',
  'Cookie',
  'set-cookie',
  'password',
  'PASSWD',
  'passphrase',
  'db.password',
  'connectionString',
  'connection_string',
  'DSN',
  'sentry_dsn',
  'stack',
  'stackTrace',
  'stack_trace',
  'bearer',
  'bearerToken',
  'credentials',
  'user-credential',
  'privateKey',
  'PRIVATE-KEY',
  'clientSecret',
  'webhookSecret',
];

const EVASIONS = [
  '\uFF50\uFF41\uFF53\uFF53\uFF57\uFF4F\uFF52\uFF44', // fullwidth "password"
  'pass\u200Bword', // zero-width space
  'to\u00ADken', // soft hyphen
  'SE\u200CCRET', // zero-width non-joiner
  'a\u2060pi_key', // word joiner
];

test('rejects the key variants named in the ruling', () => {
  for (const key of NAMED_BY_TECH_LEAD) {
    assert.equal(rejection({ [key]: 'x' }).rule, 'sensitive-key', key);
  }
});

test('rejects further spellings: camelCase, kebab-case, headers, dotted names', () => {
  for (const key of FURTHER_VARIANTS) {
    assert.equal(rejection({ [key]: 'x' }).rule, 'sensitive-key', key);
  }
});

test('rejects evasion by full-width letters and invisible characters', () => {
  for (const key of EVASIONS) {
    assert.equal(rejection({ [key]: 'x' }).rule, 'sensitive-key', JSON.stringify(key));
  }
});

test('rejects a sensitive key at any depth and inside arrays', () => {
  const key = 'refresh_token';
  assert.equal(rejection({ a: { b: { [key]: 1 } } }).rule, 'sensitive-key');
  assert.equal(rejection({ list: [{ [key]: 1 }] }).rule, 'sensitive-key');
  assert.equal(rejection({ list: [[{ [key]: 1 }]] }).rule, 'sensitive-key');
  assert.equal(rejection({ ok: 1, list: [{ fine: 1 }, { [key]: 1 }] }).rule, 'sensitive-key');
});

test('rejects a sensitive key whatever its value', () => {
  for (const value of [null, '', false, 0, [], {}]) {
    assert.equal(rejection({ password: value }).rule, 'sensitive-key', JSON.stringify(value));
  }
});

test('still accepts ordinary diagnostic keys', () => {
  const safe = {
    field: 'email',
    fields: ['name', 'email'],
    reason: 'too-long',
    code: 'E100',
    limit: 10,
    maxLength: 64,
    expected: 'string',
    path: ['body', 'name'],
    count: 2,
    index: 1,
    retryAfterSeconds: 30,
  };
  assert.deepEqual(copySafeDetails(safe), safe);
});

test('the rule is distinct from the prototype-key rule', () => {
  assert.equal(rejection({ password: 'x' }).rule, 'sensitive-key');
  assert.equal(rejection(JSON.parse('{"constructor": 1}')).rule, 'unsafe-key');
});

test('the rejection message never contains the offending key', () => {
  const keys = [`token${SENTINEL}`, `${SENTINEL}_password`, `x-${SENTINEL}-secret`];
  for (const key of keys) {
    const error = rejection({ [key]: 'x' });
    assert.match(error.message, /^Unsafe error details: [a-z-]+$/);
    assert.ok(!error.message.includes(SENTINEL), 'a key appeared in the message');
    assert.ok(!String(error.stack).includes(SENTINEL), 'a key appeared in the stack');
  }
});
