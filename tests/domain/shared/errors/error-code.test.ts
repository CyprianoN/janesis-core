import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, type ErrorCode } from '../../../../src/domain/shared/errors/error-code.js';

function assertNever(value: never): never {
  throw new Error(`unhandled error code: ${String(value)}`);
}

// If a code is added or removed without updating this switch, `npm run typecheck` fails.
function label(code: ErrorCode): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'validation';
    case 'UNAUTHORIZED':
      return 'unauthorized';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'NOT_FOUND':
      return 'not found';
    case 'CONFLICT':
      return 'conflict';
    case 'INTERNAL_ERROR':
      return 'internal';
    default:
      return assertNever(code);
  }
}

test('defines exactly the six canonical error codes, in order', () => {
  assert.deepEqual(
    [...ERROR_CODES],
    ['VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INTERNAL_ERROR'],
  );
});

test('codes are unique and written in uppercase snake case', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const code of ERROR_CODES) {
    assert.match(code, /^[A-Z]+(_[A-Z]+)*$/, code);
  }
});

test('the list of codes is frozen so it cannot be extended at runtime', () => {
  assert.ok(Object.isFrozen(ERROR_CODES));
});

test('every code is handled by an exhaustive switch', () => {
  for (const code of ERROR_CODES) {
    assert.ok(label(code).length > 0, code);
  }
});
