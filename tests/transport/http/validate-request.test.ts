import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { z } from 'zod';
import { AppError } from '../../../src/domain/shared/errors/app-error.js';
import { registerErrorHandler } from '../../../src/transport/http/plugins/error-handler.plugin.js';
import { validateInput } from '../../../src/transport/http/middlewares/validate-request.js';
import { SENTINEL } from '../../utils/transport-error-matrix.js';

interface MappedIssue {
  path: string[];
  code: string;
}

function failure(schema: z.ZodType, input: unknown): AppError {
  try {
    validateInput(schema, input);
  } catch (error) {
    assert.ok(error instanceof AppError, 'only an AppError may be thrown');
    return error;
  }
  return assert.fail('expected validateInput to throw');
}

function issuesOf(error: AppError): MappedIssue[] {
  return (error.details as unknown as { issues: MappedIssue[] }).issues;
}

const SEGMENT = /^([A-Za-z0-9_]{1,32}|\*)$/;

test('success returns the parsed, typed value', () => {
  const value = validateInput(z.object({ n: z.coerce.number() }), { n: '7' });
  assert.deepEqual(value, { n: 7 });
  assert.equal(typeof value.n, 'number');
});

test('failure throws VALIDATION_ERROR with the exact details shape', () => {
  const error = failure(z.object({ name: z.string() }), { name: 5 });
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.deepEqual(error.details, { issues: [{ path: ['name'], code: 'invalid_type' }] });
});

const CODE_ROWS: { code: string; schema: z.ZodType; input: unknown }[] = [
  { code: 'invalid_type', schema: z.string(), input: 1 },
  { code: 'too_big', schema: z.string().max(2), input: 'abc' },
  { code: 'too_small', schema: z.string().min(2), input: 'a' },
  { code: 'invalid_format', schema: z.string().regex(/^a$/), input: 'b' },
  { code: 'not_multiple_of', schema: z.number().multipleOf(5), input: 3 },
  { code: 'unrecognized_keys', schema: z.strictObject({ a: z.string() }), input: { a: 'x', b: 1 } },
  { code: 'invalid_union', schema: z.union([z.string(), z.number()]), input: true },
  { code: 'invalid_key', schema: z.record(z.string().min(3), z.string()), input: { a: 'x' } },
  {
    code: 'invalid_element',
    schema: z.map(z.bigint(), z.number()),
    input: new Map([[BigInt(123), BigInt(123)]]),
  },
  { code: 'invalid_value', schema: z.literal('a'), input: 'b' },
  { code: 'custom', schema: z.string().refine(() => false), input: 'x' },
];

for (const row of CODE_ROWS) {
  test('maps the Zod code ' + row.code, () => {
    const zodIssue = row.schema.safeParse(row.input).error?.issues[0];
    assert.equal(zodIssue?.code, row.code, 'fixture must produce the intended Zod code');
    assert.equal(issuesOf(failure(row.schema, row.input))[0]?.code, row.code);
  });
}

function fakeSchema(issues: unknown[]): z.ZodType {
  return { safeParse: () => ({ success: false, error: { issues } }) } as unknown as z.ZodType;
}

test('an unknown or missing issue code maps to invalid', () => {
  const error = failure(
    fakeSchema([
      { code: 'weird', path: [], input: SENTINEL, message: SENTINEL },
      { path: [], input: SENTINEL, message: SENTINEL },
    ]),
    {},
  );
  assert.deepEqual(
    issuesOf(error).map((i) => i.code),
    ['invalid', 'invalid'],
  );
});

test('path segments: allowed strings pass, numbers become strings, the rest become *', () => {
  const error = failure(
    fakeSchema([
      {
        code: 'custom',
        path: ['user_name', 3, Symbol('s'), 'a.b.c', 'has space', 'x'.repeat(33), ''],
        message: SENTINEL,
      },
    ]),
    {},
  );
  assert.deepEqual(issuesOf(error)[0]?.path, ['user_name', '3', '*', '*', '*', '*', '*']);
});

test('no Zod input or message is ever forwarded', () => {
  const error = failure(z.object({ a: z.string().refine(() => false, { message: SENTINEL }) }), {
    a: SENTINEL,
  });
  assert.ok(!JSON.stringify(error.details).includes(SENTINEL));
  assert.ok(!error.message.includes(SENTINEL));
  const fake = failure(
    fakeSchema([{ code: 'custom', path: ['a'], input: SENTINEL, message: SENTINEL }]),
    {},
  );
  assert.ok(!JSON.stringify(fake.details).includes(SENTINEL));
});

test('sensitive-looking field names still give VALIDATION_ERROR, not a failure of the details model', () => {
  const schema = z.object({
    password: z.string(),
    accessToken: z.string(),
    authorization: z.string(),
  });
  const error = failure(schema, { password: 1, accessToken: 2, authorization: 3 });
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.deepEqual(
    issuesOf(error).map((i) => i.path),
    [['password'], ['accessToken'], ['authorization']],
  );
});

test('adversarial failures never break the details model and stay within the byte limit', () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 300; i += 1) many['k' + i + 'x'.repeat(40)] = 'not-a-number';
  for (const key of ['password', 'eyJabcd.eyJabcd.eyJabcd', 'Bearer abcdefgh', 'a'.repeat(300)]) {
    many[key] = 'not-a-number';
  }
  const deep: z.ZodType = z.lazy(() => z.object({ c: deep }));
  let nested: unknown = {};
  for (let i = 0; i < 40; i += 1) nested = { c: nested };
  const cases: [z.ZodType, unknown][] = [
    [z.record(z.string(), z.number()), many],
    [deep, nested],
    [z.array(z.number()), Array.from({ length: 500 }, () => 'x')],
  ];
  for (const [schema, input] of cases) {
    const error = failure(schema, input);
    assert.equal(error.code, 'VALIDATION_ERROR');
    const issues = issuesOf(error);
    assert.ok(issues.length >= 1 && issues.length <= 6);
    for (const issue of issues) {
      for (const segment of issue.path) assert.match(segment, SEGMENT);
      assert.ok(issue.path.length <= 8);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(error.details)) <= 2048);
  }
});

const app = Fastify({ logger: false });
registerErrorHandler(app);
const BODY_SCHEMA = z.strictObject({ name: z.string() });
app.post('/__test/validate', async (request) => validateInput(BODY_SCHEMA, request.body));
after(async () => {
  await app.close();
});

test('through the Phase 6 handler: 400, canonical envelope, no input echoed', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/__test/validate',
    payload: { name: 5, [SENTINEL]: 'x' },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error: { code: string; details: { issues: MappedIssue[] } } };
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.issues.length >= 1);
  assert.ok(!res.body.includes(SENTINEL));
});

test('through the Phase 6 handler: a valid body returns 200', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/__test/validate',
    payload: { name: 'ok' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { name: 'ok' });
});

test('caps cut oversized failures to 6 issues of 8 segments within the byte limit', () => {
  const longPath = Array.from({ length: 12 }, () => 'a'.repeat(32));
  const issues = Array.from({ length: 10 }, () => ({ code: 'unrecognized_keys', path: longPath }));
  const error = failure(fakeSchema(issues), {});
  const mapped = issuesOf(error);
  assert.equal(mapped.length, 6);
  for (const issue of mapped) assert.equal(issue.path.length, 8);
  assert.ok(Buffer.byteLength(JSON.stringify(error.details)) <= 2048);
  const real = issuesOf(
    failure(
      z.array(z.number()),
      Array.from({ length: 500 }, () => 'x'),
    ),
  );
  assert.equal(real.length, 6);
});

test('numeric path segments: only non-negative safe integers become indices, all else is *', () => {
  const error = failure(
    fakeSchema([
      { code: 'custom', path: [0, 12, 1.5, -1, NaN, Infinity, 2 ** 53, 1e21], message: SENTINEL },
    ]),
    {},
  );
  assert.deepEqual(issuesOf(error)[0]?.path, ['0', '12', '*', '*', '*', '*', '*', '*']);
});
