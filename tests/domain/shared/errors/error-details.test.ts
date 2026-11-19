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

test('returns a frozen deep copy of safe details', () => {
  const input = { fields: ['name', 'email'], count: 2, nested: { ok: true, none: null } };
  const copy = copySafeDetails(input);
  assert.deepEqual(copy, input);
  assert.notEqual(copy, input);
  assert.ok(Object.isFrozen(copy));
  assert.ok(Object.isFrozen(copy['fields']));
  assert.ok(Object.isFrozen(copy['nested']));
  input.fields.push('later');
  assert.deepEqual(copy['fields'], ['name', 'email']);
});

test('accepts every JSON-compatible value type, including null-prototype objects', () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare['value'] = 1;
  const input = {
    s: 'text',
    n: 3.5,
    zero: 0,
    negative: -2,
    yes: true,
    no: false,
    nothing: null,
    list: [1, 'a', null, { x: 1 }],
    bare,
  };
  assert.deepEqual(copySafeDetails(input), { ...input, bare: { value: 1 } });
});

test('accepts an empty object and a shared (non-cyclic) reference used twice', () => {
  assert.deepEqual(copySafeDetails({}), {});
  const shared = { x: 1 };
  assert.deepEqual(copySafeDetails({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } });
});

test('rejects details that are not a plain object', () => {
  const inputs: unknown[] = ['text', ['a'], 42, true, null, undefined, () => 1, Symbol('x'), 10n];
  for (const input of inputs) {
    assert.equal(rejection(input).rule, 'not-an-object', typeof input);
  }
});

const hidden = {};
Object.defineProperty(hidden, 'a', { value: 1, enumerable: false });

const unsupported: Array<[string, unknown]> = [
  ['undefined', { a: undefined }],
  ['function', { a: () => 1 }],
  ['symbol', { a: Symbol('x') }],
  ['bigint', { a: 10n }],
  ['NaN', { a: Number.NaN }],
  ['Infinity', { a: Number.POSITIVE_INFINITY }],
  ['negative Infinity', { a: Number.NEGATIVE_INFINITY }],
  ['Date', { a: new Date(0) }],
  ['Map', { a: new Map() }],
  ['Set', { a: new Set() }],
  ['RegExp', { a: /x/ }],
  ['Error', { a: new Error('x') }],
  ['Uint8Array', { a: new Uint8Array(1) }],
  ['Promise', { a: Promise.resolve(1) }],
  [
    'class instance',
    {
      a: new (class Example {
        x = 1;
      })(),
    },
  ],
  ['boxed string', { a: new String('x') }],
  ['undefined inside an array', { a: [1, undefined] }],
  ['function nested deeper', { a: { b: { c: () => 1 } } }],
  ['non-enumerable property', { a: hidden }],
];

test('rejects values that are not JSON-compatible', () => {
  for (const [label, input] of unsupported) {
    assert.equal(rejection(input).rule, 'unsupported-value', label);
  }
});

test('rejects getters and setters without ever invoking them', () => {
  let calls = 0;
  const withGetter = {};
  Object.defineProperty(withGetter, 'a', {
    enumerable: true,
    get() {
      calls += 1;
      return 1;
    },
  });
  const withSetter = {};
  Object.defineProperty(withSetter, 'a', {
    enumerable: true,
    set() {
      calls += 1;
    },
  });
  assert.equal(rejection(withGetter).rule, 'accessor-property');
  assert.equal(rejection(withSetter).rule, 'accessor-property');
  assert.equal(rejection({ nested: withGetter }).rule, 'accessor-property');
  assert.equal(calls, 0, 'an accessor was invoked during validation');
});

test('rejects custom serialization without invoking it', () => {
  let calls = 0;
  const own = {
    toJSON() {
      calls += 1;
      return {};
    },
  };
  assert.equal(rejection(own).rule, 'custom-serialization');
  assert.equal(rejection({ a: own }).rule, 'custom-serialization');
  assert.equal(rejection({ toJSON: 'not a function' }).rule, 'custom-serialization');
  assert.equal(calls, 0, 'toJSON was invoked during validation');
});

test('rejects prototype-related keys at any depth', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const parsed = JSON.parse(`{"${key}": 1}`) as unknown;
    assert.equal(rejection(parsed).rule, 'unsafe-key', key);
    assert.equal(rejection({ nested: parsed }).rule, 'unsafe-key', key);
  }
});

test('rejects symbol keys, sparse arrays and cycles', () => {
  assert.equal(rejection({ [Symbol('x')]: 1 }).rule, 'symbol-key');

  const sparse = new Array(3);
  sparse[0] = 1;
  assert.equal(rejection({ a: sparse }).rule, 'sparse-array');

  const cyclicObject: Record<string, unknown> = {};
  cyclicObject['self'] = cyclicObject;
  assert.equal(rejection(cyclicObject).rule, 'cycle');

  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  assert.equal(rejection({ a: cyclicArray }).rule, 'cycle');
});

test('rejection messages name only the rule, never a key or a value', () => {
  const inputs: unknown[] = [
    { [SENTINEL]: () => 1 },
    { a: SENTINEL, b: undefined },
    { [SENTINEL]: new Date(0) },
    JSON.parse(`{"${SENTINEL}": {"__proto__": 1}}`),
  ];
  for (const input of inputs) {
    const error = rejection(input);
    assert.match(error.message, /^Unsafe error details: [a-z-]+$/);
    assert.ok(!error.message.includes(SENTINEL), 'a key or value appeared in the message');
    assert.ok(!String(error.stack).includes(SENTINEL), 'a key or value appeared in the stack');
  }
});
