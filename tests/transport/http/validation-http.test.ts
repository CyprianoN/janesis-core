import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildApp } from '../../../src/transport/http/app.js';
import { validateInput } from '../../../src/transport/http/middlewares/validate-request.js';
import { boundedString, uuidSchema } from '../../../src/validators/consistency-registry.js';
import { SENTINEL } from '../../utils/transport-error-matrix.js';

const VALID_ID = '3f2b8c1e-5d4a-4b7e-9a1c-2e6f8d0b7a43';
const BODY_SCHEMA = z.strictObject({
  id: uuidSchema,
  label: boundedString(32),
  count: z.number().int(),
});

// Test-only recording use case: it records what the application layer would receive.
const received: { parsed: unknown[]; raw: unknown[] } = { parsed: [], raw: [] };

const app = buildApp();
app.post('/__test/validation/body', async (request) => {
  const parsed = validateInput(BODY_SCHEMA, request.body);
  received.raw.push(request.body);
  received.parsed.push(parsed);
  return { ok: true };
});
after(async () => {
  await app.close();
});
beforeEach(() => {
  received.parsed.length = 0;
  received.raw.length = 0;
});

async function post(
  payload: string | undefined,
  contentType: string | undefined = 'application/json',
) {
  return app.inject({
    method: 'POST',
    url: '/__test/validation/body',
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    payload,
  });
}

const valid = { id: VALID_ID, label: 'quest', count: 3 };
const json = (value: unknown): string => JSON.stringify(value);

const INVALID: { name: string; payload: string | undefined; contentType?: string }[] = [
  { name: 'missing body', payload: undefined, contentType: undefined },
  { name: 'null body', payload: 'null' },
  { name: 'array body', payload: '[]' },
  { name: 'string body', payload: '"text"' },
  { name: 'number body', payload: '42' },
  { name: 'empty object', payload: '{}' },
  { name: 'missing field', payload: json({ id: VALID_ID, count: 1 }) },
  { name: 'wrong type', payload: json({ ...valid, label: 5 }) },
  { name: 'invalid uuid', payload: json({ ...valid, id: 'nope' }) },
  { name: 'empty label', payload: json({ ...valid, label: '' }) },
  { name: 'label too long', payload: json({ ...valid, label: 'x'.repeat(33) }) },
  { name: 'non-integer count', payload: json({ ...valid, count: 1.5 }) },
  { name: 'extra field', payload: json({ ...valid, extra: true }) },
  { name: 'sensitive-named extra field', payload: json({ ...valid, password: SENTINEL }) },
  {
    name: 'nested sentinel in a wrong-typed field',
    payload: json({ ...valid, label: { a: SENTINEL } }),
  },
  { name: 'malformed JSON', payload: '{"id": ' + SENTINEL },
  { name: 'empty JSON body', payload: '' },
  { name: 'prototype poisoning payload', payload: '{"__proto__":{"x":1}}' },
];

for (const row of INVALID) {
  test(
    'invalid body (' + row.name + ') gives 400 VALIDATION_ERROR and never reaches the use case',
    async () => {
      const res = await post(
        row.payload,
        'contentType' in row ? row.contentType : 'application/json',
      );
      assert.equal(res.statusCode, 400);
      const body = res.json() as {
        error: { code: string; message: string; details?: { issues: unknown } };
      };
      assert.deepEqual(Object.keys(body), ['error']);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(body.error.message, 'The request is invalid.');
      if (body.error.details !== undefined) assert.ok(Array.isArray(body.error.details.issues));
      assert.equal(received.parsed.length, 0);
      assert.ok(!res.body.includes(SENTINEL));
      assert.ok(!res.body.includes('password'));
    },
  );
}

const VALID: { name: string; value: unknown }[] = [
  { name: 'minimal', value: valid },
  { name: 'label at the maximum length', value: { ...valid, label: 'x'.repeat(32) } },
  { name: 'count zero', value: { ...valid, count: 0 } },
];

for (const row of VALID) {
  test('valid body (' + row.name + ') reaches the use case as the parsed value', async () => {
    const res = await post(json(row.value));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(received.parsed.length, 1);
    assert.deepEqual(received.parsed[0], row.value);
    assert.notEqual(received.parsed[0], received.raw[0]);
  });
}

// WP8-02: route parameter validation through the same composed app.
const PARAMS_SCHEMA = z.strictObject({ id: uuidSchema });
const ITEM_PARAMS_SCHEMA = z.strictObject({ id: uuidSchema, itemId: uuidSchema });
const OTHER_ID = '9c1d7e52-0a4b-4f6e-8d3a-5b2e1f7c4a90';

app.get('/__test/validation/params/:id', async (request) => {
  const parsed = validateInput(PARAMS_SCHEMA, request.params);
  received.raw.push(request.params);
  received.parsed.push(parsed);
  return { ok: true };
});
app.get('/__test/validation/params/:id/items/:itemId', async (request) => {
  const parsed = validateInput(ITEM_PARAMS_SCHEMA, request.params);
  received.raw.push(request.params);
  received.parsed.push(parsed);
  return { ok: true };
});

const PARAMS_BASE = '/__test/validation/params/';

const INVALID_PARAMS: { name: string; url: string }[] = [
  { name: 'not a uuid', url: PARAMS_BASE + 'not-a-uuid' },
  { name: 'uuid plus a trailing character', url: PARAMS_BASE + VALID_ID + 'x' },
  { name: 'uuid without hyphens', url: PARAMS_BASE + VALID_ID.replaceAll('-', '') },
  { name: 'sentinel as the id', url: PARAMS_BASE + SENTINEL },
  { name: 'second parameter invalid', url: PARAMS_BASE + VALID_ID + '/items/bad-item' },
  { name: 'first parameter invalid', url: PARAMS_BASE + 'bad-id/items/' + OTHER_ID },
];

for (const row of INVALID_PARAMS) {
  test(
    'invalid route parameter (' +
      row.name +
      ') gives 400 VALIDATION_ERROR and never reaches the use case',
    async () => {
      const res = await app.inject({ method: 'GET', url: row.url });
      assert.equal(res.statusCode, 400);
      const body = res.json() as { error: { code: string; message: string } };
      assert.deepEqual(Object.keys(body), ['error']);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(body.error.message, 'The request is invalid.');
      assert.equal(received.parsed.length, 0);
      assert.ok(!res.body.includes(SENTINEL));
    },
  );
}

// HARD-002 (carry-forward, Phase 6 transport composition): Fastify rejects these requests before
// routing, so neither the route nor validateInput runs and the Phase 6 handler is bypassed. The
// rows pin the observed behavior and are marked todo so they stay visible without gating the suite.
// When HARD-002 is remediated these rows are expected to fail and must be rewritten to the canonical contract.
const EDGE_PARAMS: { name: string; url: string; status: number; code: string }[] = [
  {
    name: 'over-long parameter (101 characters)',
    url: PARAMS_BASE + 'a'.repeat(101),
    status: 414,
    code: 'FST_ERR_MAX_PARAM_LENGTH',
  },
  {
    name: 'malformed percent-encoding',
    url: PARAMS_BASE + '%E0%A4%A',
    status: 400,
    code: 'FST_ERR_BAD_URL',
  },
];

for (const row of EDGE_PARAMS) {
  test(
    'HARD-002 edge route parameter (' + row.name + ') currently bypasses the canonical envelope',
    {
      todo: 'HARD-002: Fastify pre-routing errors bypass canonical error handling (Phase 6 carry-forward)',
    },
    async () => {
      const res = await app.inject({ method: 'GET', url: row.url });
      assert.equal(res.statusCode, row.status);
      const body = res.json() as {
        error: unknown;
        code: string;
        message: string;
        statusCode: number;
      };
      assert.equal(body.code, row.code);
      assert.equal(body.statusCode, row.status);
      assert.equal(typeof body.error, 'string');
      assert.ok(body.message.includes(row.url), 'the complete submitted path is reflected');
      assert.equal(received.parsed.length, 0);
    },
  );
}

test('a 100-character route parameter still reaches the validator and gets the canonical 400', async () => {
  const res = await app.inject({ method: 'GET', url: PARAMS_BASE + 'a'.repeat(100) });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error: { code: string; message: string } };
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(received.parsed.length, 0);
});

test('valid route parameter reaches the use case as the parsed value', async () => {
  const res = await app.inject({ method: 'GET', url: PARAMS_BASE + VALID_ID });
  assert.equal(res.statusCode, 200);
  assert.equal(received.parsed.length, 1);
  assert.deepEqual(received.parsed[0], { id: VALID_ID });
  assert.notEqual(received.parsed[0], received.raw[0]);
});

test('two valid route parameters reach the use case as the parsed value', async () => {
  const res = await app.inject({
    method: 'GET',
    url: PARAMS_BASE + VALID_ID + '/items/' + OTHER_ID,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(received.parsed.length, 1);
  assert.deepEqual(received.parsed[0], { id: VALID_ID, itemId: OTHER_ID });
  assert.notEqual(received.parsed[0], received.raw[0]);
});

// WP8-03: query parameter validation through the same composed app. The bounds below are
// harness-only values owned by this test, not shared business rules.
const digits = (min: number, max: number) =>
  z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const QUERY_SCHEMA = z.strictObject({
  limit: digits(1, 50),
  offset: digits(0, 999999).optional(),
  status: z.enum(['open', 'closed']).optional(),
  q: boundedString(32).optional(),
});
const QUERY_PATH = '/__test/validation/query';

app.get(QUERY_PATH, async (request) => {
  const parsed = validateInput(QUERY_SCHEMA, request.query);
  received.raw.push(request.query);
  received.parsed.push(parsed);
  return { ok: true };
});

const INVALID_QUERIES: { name: string; url: string }[] = [
  { name: 'no query string', url: QUERY_PATH },
  { name: 'empty limit', url: QUERY_PATH + '?limit=' },
  { name: 'non-numeric limit', url: QUERY_PATH + '?limit=abc' },
  { name: 'limit below the minimum', url: QUERY_PATH + '?limit=0' },
  { name: 'limit above the maximum', url: QUERY_PATH + '?limit=51' },
  { name: 'negative limit', url: QUERY_PATH + '?limit=-1' },
  { name: 'fractional limit', url: QUERY_PATH + '?limit=1.5' },
  { name: 'exponent limit', url: QUERY_PATH + '?limit=1e1' },
  { name: 'hex limit', url: QUERY_PATH + '?limit=0x10' },
  { name: 'limit with a leading space', url: QUERY_PATH + '?limit=%205' },
  { name: 'repeated limit', url: QUERY_PATH + '?limit=10&limit=20' },
  { name: 'unknown status', url: QUERY_PATH + '?limit=10&status=pending' },
  { name: 'empty status', url: QUERY_PATH + '?limit=10&status=' },
  { name: 'unknown key', url: QUERY_PATH + '?limit=10&unknown=1' },
  { name: 'empty q', url: QUERY_PATH + '?limit=10&q=' },
  { name: 'q too long', url: QUERY_PATH + '?limit=10&q=' + 'x'.repeat(33) },
  { name: 'sentinel as the limit', url: QUERY_PATH + '?limit=' + SENTINEL },
  { name: 'sensitive-named unknown key', url: QUERY_PATH + '?limit=10&password=' + SENTINEL },
  { name: 'bracket syntax', url: QUERY_PATH + '?limit%5B%5D=1' },
];

for (const row of INVALID_QUERIES) {
  test(
    'invalid query (' + row.name + ') gives 400 VALIDATION_ERROR and never reaches the use case',
    async () => {
      const res = await app.inject({ method: 'GET', url: row.url });
      assert.equal(res.statusCode, 400);
      const body = res.json() as { error: { code: string; message: string } };
      assert.deepEqual(Object.keys(body), ['error']);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(body.error.message, 'The request is invalid.');
      assert.equal(received.parsed.length, 0);
      assert.ok(!res.body.includes(SENTINEL));
      assert.ok(!res.body.includes('password'));
    },
  );
}

const VALID_QUERIES: { name: string; url: string; expected: unknown }[] = [
  { name: 'limit only', url: QUERY_PATH + '?limit=10', expected: { limit: 10 } },
  {
    name: 'all fields',
    url: QUERY_PATH + '?limit=50&offset=0&status=open&q=abc',
    expected: { limit: 50, offset: 0, status: 'open', q: 'abc' },
  },
  {
    name: 'boundary values',
    url: QUERY_PATH + '?limit=1&offset=999999',
    expected: { limit: 1, offset: 999999 },
  },
  {
    name: 'percent-encoded q',
    url: QUERY_PATH + '?limit=5&q=a%20b',
    expected: { limit: 5, q: 'a b' },
  },
];

for (const row of VALID_QUERIES) {
  test(
    'valid query (' + row.name + ') reaches the use case as normalized, typed values',
    async () => {
      const res = await app.inject({ method: 'GET', url: row.url });
      assert.equal(res.statusCode, 200);
      assert.equal(received.parsed.length, 1);
      assert.deepEqual(received.parsed[0], row.expected);
      assert.equal(typeof (received.parsed[0] as { limit: unknown }).limit, 'number');
      assert.notEqual(received.parsed[0], received.raw[0]);
    },
  );
}

test('a __proto__ query key pollutes nothing and never reaches the use case as a key', async () => {
  const res = await app.inject({ method: 'GET', url: QUERY_PATH + '?limit=10&__proto__=x' });
  assert.ok(res.statusCode === 200 || res.statusCode === 400, 'observed status ' + res.statusCode);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(({} as Record<string, unknown>)['x'], undefined);
  if (res.statusCode === 200) {
    assert.deepEqual(received.parsed[0], { limit: 10 });
  } else {
    assert.equal(received.parsed.length, 0);
  }
});

test('control: bare z.coerce.number() would silently accept empty, hex and exponent values', () => {
  const coerced = z.coerce.number().int().min(0);
  assert.equal(coerced.safeParse('').success, true);
  assert.equal(coerced.safeParse('0x10').success, true);
  assert.equal(coerced.safeParse('1e1').success, true);
});
