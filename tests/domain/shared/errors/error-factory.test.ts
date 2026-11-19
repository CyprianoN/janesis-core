import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../../../src/domain/shared/errors/app-error.js';
import { ERROR_CODES } from '../../../../src/domain/shared/errors/error-code.js';
import {
  DEFAULT_MESSAGES,
  conflict,
  forbidden,
  internalError,
  notFound,
  unauthorized,
  validationError,
} from '../../../../src/domain/shared/errors/error-factory.js';
import { InvalidErrorDetailsError } from '../../../../src/domain/shared/errors/error.types.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';

const FACTORIES = [
  ['VALIDATION_ERROR', validationError],
  ['UNAUTHORIZED', unauthorized],
  ['FORBIDDEN', forbidden],
  ['NOT_FOUND', notFound],
  ['CONFLICT', conflict],
  ['INTERNAL_ERROR', internalError],
] as const;

test('there is exactly one factory per canonical code', () => {
  assert.deepEqual(
    FACTORIES.map(([code]) => code),
    [...ERROR_CODES],
  );
});

test('each factory creates an AppError with its own code', () => {
  for (const [code, factory] of FACTORIES) {
    const error = factory();
    assert.ok(error instanceof AppError, code);
    assert.equal(error.code, code);
  }
});

test('default messages are generic, non-blank and cover every code', () => {
  assert.deepEqual(Object.keys(DEFAULT_MESSAGES).sort(), [...ERROR_CODES].sort());
  assert.ok(Object.isFrozen(DEFAULT_MESSAGES));
  for (const code of ERROR_CODES) {
    assert.ok(DEFAULT_MESSAGES[code].trim().length > 0, code);
  }
  for (const [code, factory] of FACTORIES) {
    assert.equal(factory().message, DEFAULT_MESSAGES[code], code);
  }
});

test('the internal error default matches the aligned IADP example', () => {
  assert.equal(DEFAULT_MESSAGES.INTERNAL_ERROR, 'An unexpected error occurred.');
  assert.equal(internalError().message, 'An unexpected error occurred.');
});

test('a custom message and safe details are passed through', () => {
  for (const [code, factory] of FACTORIES) {
    const error = factory('Custom message.', { field: 'email' });
    assert.equal(error.code, code);
    assert.equal(error.message, 'Custom message.');
    assert.deepEqual(error.details, { field: 'email' });
  }
});

test('unsafe details are rejected through every factory without exposing values', () => {
  for (const [, factory] of FACTORIES) {
    try {
      factory('Message.', { apiKey: SENTINEL });
      assert.fail('expected the factory to throw');
    } catch (error) {
      assert.ok(error instanceof InvalidErrorDetailsError, 'expected an InvalidErrorDetailsError');
      assert.ok(!error.message.includes(SENTINEL));
    }
  }
});
