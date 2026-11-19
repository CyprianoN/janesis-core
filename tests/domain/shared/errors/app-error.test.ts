import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../../../src/domain/shared/errors/app-error.js';
import { ERROR_CODES, type ErrorCode } from '../../../../src/domain/shared/errors/error-code.js';
import { InvalidErrorDetailsError } from '../../../../src/domain/shared/errors/error.types.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';

test('is an Error named AppError that carries its code and message', () => {
  const error = new AppError('NOT_FOUND', 'The thing was not found.');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof AppError);
  assert.equal(error.name, 'AppError');
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.message, 'The thing was not found.');
  assert.equal(typeof error.stack, 'string');
});

test('accepts every canonical code', () => {
  for (const code of ERROR_CODES) {
    assert.equal(new AppError(code, 'Message.').code, code);
  }
});

test('has no details by default', () => {
  assert.equal(new AppError('CONFLICT', 'Message.').details, undefined);
});

test('stores a frozen safe copy of details that later mutation cannot change', () => {
  const input = { fields: ['name'], count: 1 };
  const error = new AppError('VALIDATION_ERROR', 'Message.', input);
  assert.deepEqual(error.details, { fields: ['name'], count: 1 });
  assert.ok(Object.isFrozen(error.details));
  input.fields.push('later');
  assert.deepEqual(error.details, { fields: ['name'], count: 1 });
});

test('treats an empty details object as absent', () => {
  assert.equal(new AppError('CONFLICT', 'Message.', {}).details, undefined);
});

test('rejects unsafe details at construction without exposing values', () => {
  const unsafe: unknown[] = [
    { password: SENTINEL },
    { note: `Bearer ${SENTINEL}` },
    { a: () => SENTINEL },
    'a string is not an object',
    null,
    ['array'],
  ];
  for (const details of unsafe) {
    try {
      new AppError('VALIDATION_ERROR', 'Message.', details);
      assert.fail('expected the constructor to throw');
    } catch (error) {
      assert.ok(error instanceof InvalidErrorDetailsError, 'expected an InvalidErrorDetailsError');
      assert.ok(!error.message.includes(SENTINEL), 'a value appeared in the message');
    }
  }
});

test('rejects an unknown code at runtime without echoing it', () => {
  assert.throws(
    () => new AppError('NOPE_SENTINEL' as ErrorCode, 'Message.'),
    (error: unknown) => error instanceof TypeError && !error.message.includes('NOPE_SENTINEL'),
  );
});

test('requires a non-blank message string and never echoes a bad one', () => {
  const bad: unknown[] = ['', '   ', 42, null, undefined, { text: SENTINEL }];
  for (const message of bad) {
    assert.throws(
      () => new AppError('CONFLICT', message as string),
      (error: unknown) => error instanceof TypeError && !error.message.includes(SENTINEL),
    );
  }
});

test('is immutable after construction', () => {
  const error = new AppError('FORBIDDEN', 'Message.', { reason: 'role' });
  assert.ok(Object.isFrozen(error));
  assert.throws(() => {
    (error as { code: string }).code = 'INTERNAL_ERROR';
  }, TypeError);
  assert.equal(error.code, 'FORBIDDEN');
});
