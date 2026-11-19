import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/domain/shared/errors/app-error.js';
import { validateInput } from '../../src/transport/http/middlewares/validate-request.js';
import { xApiResponseSchema } from '../../src/validators/verification.schema.js';
import { SENTINEL } from '../utils/transport-error-matrix.js';

// WP8-08 (DEC-008-01, W-A): structural validation of an X API response only. The fixtures are
// synthetic and sanitized. No X field names, endpoints or adapter behavior are established here.
const NON_OBJECTS: [string, unknown][] = [
  ['null', null],
  ['an array', []],
  ['a string', 'text'],
  ['a number', 42],
  ['a boolean', true],
  ['undefined', undefined],
];

test('accepts a synthetic JSON object, keeps unknown fields and returns a different object', () => {
  const input = { data: { id: 'synthetic-1', note: 'x' }, meta: { count: 1 }, extra: [1, 2, 3] };
  const parsed = xApiResponseSchema.parse(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
});

for (const [name, value] of NON_OBJECTS) {
  test('rejects ' + name, () => {
    assert.equal(xApiResponseSchema.safeParse(value).success, false);
  });
}

test('a __proto__ key does not pollute prototypes', () => {
  const parsed = xApiResponseSchema.parse(JSON.parse('{"__proto__":{"polluted":true},"a":1}'));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.equal((parsed as Record<string, unknown>)['polluted'], undefined);
});

test('a non-object response gives a canonical VALIDATION_ERROR through validateInput and echoes nothing', () => {
  assert.throws(
    () => validateInput(xApiResponseSchema, SENTINEL),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.deepEqual(error.details, { issues: [{ path: [], code: 'invalid_type' }] });
      assert.ok(!JSON.stringify(error.details).includes(SENTINEL));
      assert.ok(!error.message.includes(SENTINEL));
      return true;
    },
  );
});
