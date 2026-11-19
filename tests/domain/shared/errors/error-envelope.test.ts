import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, toEnvelope } from '../../../../src/domain/shared/errors/app-error.js';
import { ERROR_CODES } from '../../../../src/domain/shared/errors/error-code.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';

test('produces { error: { code, message } } and omits details when absent', () => {
  const envelope = toEnvelope(new AppError('NOT_FOUND', 'The thing was not found.'));
  assert.deepEqual(envelope, { error: { code: 'NOT_FOUND', message: 'The thing was not found.' } });
  assert.deepEqual(Object.keys(envelope), ['error']);
  assert.deepEqual(Object.keys(envelope.error), ['code', 'message']);
  assert.ok(!('details' in envelope.error));
});

test('includes details when present', () => {
  const envelope = toEnvelope(
    new AppError('VALIDATION_ERROR', 'The request is invalid.', { fields: ['email'] }),
  );
  assert.deepEqual(envelope, {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid.',
      details: { fields: ['email'] },
    },
  });
});

test('omits details entirely, never an empty object, when there is nothing to report', () => {
  const envelope = toEnvelope(new AppError('CONFLICT', 'Message.', {}));
  assert.ok(!('details' in envelope.error));
  assert.ok(!JSON.stringify(envelope).includes('details'));
});

test('every canonical code is carried through unchanged', () => {
  for (const code of ERROR_CODES) {
    assert.equal(toEnvelope(new AppError(code, 'Message.')).error.code, code);
  }
});

test('exposes only code, message and details: no stack, name or cause', () => {
  const error = new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { reason: 'x' });
  const text = JSON.stringify(toEnvelope(error));
  assert.ok(!text.includes('stack'));
  assert.ok(!text.includes('AppError'));
  assert.ok(!text.includes('cause'));
  assert.ok(!text.includes(String(error.stack).slice(0, 40)));
});

test('the envelope is frozen and survives a JSON round trip unchanged', () => {
  const envelope = toEnvelope(new AppError('FORBIDDEN', 'Message.', { reason: 'role' }));
  assert.ok(Object.isFrozen(envelope));
  assert.ok(Object.isFrozen(envelope.error));
  assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope);
});

test('rejects anything that is not an AppError without echoing it', () => {
  const impostors: unknown[] = [
    { code: 'CONFLICT', message: 'Message.', stack: SENTINEL },
    new Error(SENTINEL),
    null,
    undefined,
    'text',
    Object.create(AppError.prototype) as unknown,
  ];
  for (const impostor of impostors) {
    assert.throws(
      () => toEnvelope(impostor as AppError),
      (error: unknown) => error instanceof TypeError && !error.message.includes(SENTINEL),
    );
  }
});
