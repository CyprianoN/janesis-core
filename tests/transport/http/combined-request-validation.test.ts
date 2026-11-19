import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildApp } from '../../../src/transport/http/app.js';
import { validateInput } from '../../../src/transport/http/middlewares/validate-request.js';
import { boundedString, uuidSchema } from '../../../src/validators/consistency-registry.js';
import { SENTINEL } from '../../utils/transport-error-matrix.js';

// WP8-07A: combined body, parameter and query validation on a public-style and an internal-style
// test route. Test-only: no production route consumes input yet, and "internal" is only a path
// prefix because authorization (Phase 10) does not exist.
const VALID_ID = '3f2b8c1e-5d4a-4b7e-9a1c-2e6f8d0b7a43';
const PARAMS_SCHEMA = z.strictObject({ id: uuidSchema });
const QUERY_SCHEMA = z.strictObject({
  limit: z
    .string()
    .regex(/^[0-9]{1,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50)),
});
const BODY_SCHEMA = z.strictObject({ label: boundedString(32), count: z.number().int() });

interface Call {
  params: unknown;
  query: unknown;
  body: unknown;
  raw: { params: unknown; query: unknown; body: unknown };
}
const received: Call[] = [];

const SURFACES = ['public', 'internal'] as const;
const app = buildApp();
for (const surface of SURFACES) {
  app.post('/__test/' + surface + '/v1/items/:id', async (request) => {
    const params = validateInput(PARAMS_SCHEMA, request.params);
    const query = validateInput(QUERY_SCHEMA, request.query);
    const body = validateInput(BODY_SCHEMA, request.body);
    received.push({
      params,
      query,
      body,
      raw: { params: request.params, query: request.query, body: request.body },
    });
    return { ok: true };
  });
}
after(async () => {
  await app.close();
});
beforeEach(() => {
  received.length = 0;
});

async function call(surface: string, id: string, query: string, body: string | undefined) {
  return app.inject({
    method: 'POST',
    url: '/__test/' + surface + '/v1/items/' + id + query,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    payload: body,
  });
}

const GOOD_BODY = JSON.stringify({ label: 'quest', count: 3 });

const INVALID: { name: string; id: string; query: string; body: string | undefined }[] = [
  {
    name: 'invalid body only',
    id: VALID_ID,
    query: '?limit=10',
    body: JSON.stringify({ label: 'quest', count: 'x' }),
  },
  { name: 'missing body only', id: VALID_ID, query: '?limit=10', body: undefined },
  { name: 'invalid parameter only', id: 'nope', query: '?limit=10', body: GOOD_BODY },
  { name: 'invalid query value only', id: VALID_ID, query: '?limit=0', body: GOOD_BODY },
  { name: 'unknown query key only', id: VALID_ID, query: '?limit=10&extra=1', body: GOOD_BODY },
  { name: 'all three invalid', id: 'nope', query: '?limit=0', body: JSON.stringify({ label: 5 }) },
  {
    name: 'sentinel in every part',
    id: SENTINEL,
    query: '?limit=' + SENTINEL + '&token=' + SENTINEL,
    body: JSON.stringify({ label: { a: SENTINEL }, password: SENTINEL }),
  },
];

for (const surface of SURFACES) {
  for (const row of INVALID) {
    test(
      surface +
        ' surface: ' +
        row.name +
        ' gives 400 VALIDATION_ERROR and never reaches the use case',
      async () => {
        const res = await call(surface, row.id, row.query, row.body);
        assert.equal(res.statusCode, 400);
        const body = res.json() as { error: { code: string; message: string } };
        assert.deepEqual(Object.keys(body), ['error']);
        assert.equal(body.error.code, 'VALIDATION_ERROR');
        assert.equal(body.error.message, 'The request is invalid.');
        assert.equal(received.length, 0);
        assert.ok(!res.body.includes(SENTINEL));
        assert.ok(!res.body.includes('password'));
        assert.ok(!res.body.includes('token'));
      },
    );
  }

  test(
    surface + ' surface: a valid request reaches the use case with all three parsed values',
    async () => {
      const res = await call(surface, VALID_ID, '?limit=10', GOOD_BODY);
      assert.equal(res.statusCode, 200);
      assert.equal(received.length, 1);
      const [first] = received;
      assert.deepEqual(first?.params, { id: VALID_ID });
      assert.deepEqual(first?.query, { limit: 10 });
      assert.deepEqual(first?.body, { label: 'quest', count: 3 });
      assert.equal(typeof (first?.query as { limit: unknown }).limit, 'number');
      assert.notEqual(first?.params, first?.raw.params);
      assert.notEqual(first?.query, first?.raw.query);
      assert.notEqual(first?.body, first?.raw.body);
    },
  );
}

test('public and internal surfaces return identical validation responses for the same input', async () => {
  for (const row of INVALID) {
    const a = await call('public', row.id, row.query, row.body);
    const b = await call('internal', row.id, row.query, row.body);
    assert.equal(a.statusCode, b.statusCode, row.name);
    assert.equal(a.body, b.body, row.name);
  }
});

test('both route schemas reuse the same shared primitive', () => {
  assert.equal(PARAMS_SCHEMA.shape.id, uuidSchema);
});
