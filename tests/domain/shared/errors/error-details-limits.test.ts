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

// Depth counts the top-level object as level 1; arrays count as levels too.
function objectDepth(depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = { v: 1 };
  for (let level = 1; level < depth; level += 1) current = { a: current };
  return current;
}

// Keys k00, k01, ... are 3 bytes each, so an entry costs (3 + 4) + (length + 2) = length + 9 bytes,
// and the top-level object adds 2 bytes. 7 x 246 + 252 therefore gives exactly 2048.
function entries(lengths: number[], char = 'x'): Record<string, string> {
  const result: Record<string, string> = {};
  lengths.forEach((length, index) => {
    result[`k${String(index).padStart(2, '0')}`] = char.repeat(length);
  });
  return result;
}

test('depth: 4 levels are accepted and 5 are rejected, counting arrays as levels', () => {
  assert.doesNotThrow(() => copySafeDetails(objectDepth(4)));
  assert.equal(rejection(objectDepth(5)).rule, 'too-deep');
  assert.doesNotThrow(() => copySafeDetails({ a: [[[1]]] }));
  assert.equal(rejection({ a: [[[[1]]]] }).rule, 'too-deep');
});

test('strings: 256 characters are accepted and 257 are rejected, at any depth', () => {
  assert.doesNotThrow(() => copySafeDetails({ a: 'x'.repeat(256) }));
  assert.equal(rejection({ a: 'x'.repeat(257) }).rule, 'string-too-long');
  assert.equal(rejection({ a: { b: ['x'.repeat(257)] } }).rule, 'string-too-long');
});

test('arrays: 50 items are accepted and 51 are rejected', () => {
  assert.doesNotThrow(() => copySafeDetails({ a: new Array<number>(50).fill(1) }));
  assert.equal(rejection({ a: new Array<number>(51).fill(1) }).rule, 'too-many-items');
});

test('objects: 50 keys are accepted and 51 are rejected', () => {
  const keys = (count: number): Record<string, number> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`k${String(i).padStart(2, '0')}`, 1]),
    );
  assert.doesNotThrow(() => copySafeDetails(keys(50)));
  assert.equal(rejection(keys(51)).rule, 'too-many-keys');
});

test('size: exactly 2048 estimated bytes are accepted and 2049 are rejected', () => {
  const atLimit = entries([246, 246, 246, 246, 246, 246, 246, 252]);
  assert.doesNotThrow(() => copySafeDetails(atLimit));
  const overLimit = entries([246, 246, 246, 246, 246, 246, 246, 253]);
  assert.equal(rejection(overLimit).rule, 'too-large');
});

test('size counts UTF-8 bytes, not characters', () => {
  // 8 strings of 200 characters is 1600 characters, but 4800 bytes for a 3-byte character.
  const multibyte = entries([200, 200, 200, 200, 200, 200, 200, 200], '\u20AC');
  assert.equal(rejection(multibyte).rule, 'too-large');
});

test('the size estimate is conservative for characters that JSON escapes', () => {
  // The real JSON encoding would be about 1674 bytes, but each escaped character counts as 6.
  const quotes = entries([100, 100, 100, 100, 100, 100, 100, 100], '"');
  assert.equal(rejection(quotes).rule, 'too-large');
});

const SENSITIVE_VALUES = [
  'postgres://user:pw@db.example.invalid/app',
  'https://abc123@o1.example.invalid/1',
  'Bearer abcdefghijkl',
  'bearer   abcdefghijkl',
  'Basic dXNlcjpwYXNz',
  'Authorization: anything',
  'authorization=anything',
  'eyJhbGci.payloadpayload.signature',
  '-----BEGIN ' + 'PRIVATE KEY-----',
  '-----BEGIN RSA ' + 'PRIVATE KEY-----',
];

test('rejects values that look like credentials, at the top level, nested and in arrays', () => {
  for (const value of SENSITIVE_VALUES) {
    assert.equal(rejection({ note: value }).rule, 'sensitive-value', value);
    assert.equal(rejection({ a: { b: { note: value } } }).rule, 'sensitive-value', value);
    assert.equal(rejection({ list: ['fine', value] }).rule, 'sensitive-value', value);
  }
});

test('still accepts ordinary text that merely resembles those patterns', () => {
  const benign = [
    'https://example.invalid/docs',
    'basic information about the request',
    'The Bearer was not present',
    'Bearer',
    'Authorization is required',
    'eyJ',
    'postgres is the database',
    'Field is too long',
  ];
  for (const value of benign) {
    assert.doesNotThrow(() => copySafeDetails({ note: value }), value);
  }
});

test('rejection messages never contain a value, including for the new rules', () => {
  const inputs: unknown[] = [
    { a: `Bearer ${SENTINEL}` },
    { a: `${'x'.repeat(300)}${SENTINEL}` },
    { list: Array.from({ length: 51 }, () => SENTINEL) },
    objectDepth(5),
    entries([246, 246, 246, 246, 246, 246, 246, 253]),
  ];
  for (const input of inputs) {
    const error = rejection(input);
    assert.match(error.message, /^Unsafe error details: [a-z-]+$/);
    assert.ok(!error.message.includes(SENTINEL), 'a value appeared in the message');
    assert.ok(!String(error.stack).includes(SENTINEL), 'a value appeared in the stack');
  }
  assert.equal(rejection({ a: `Bearer ${SENTINEL}` }).rule, 'sensitive-value');
  assert.equal(rejection({ a: `${'x'.repeat(300)}${SENTINEL}` }).rule, 'string-too-long');
});
